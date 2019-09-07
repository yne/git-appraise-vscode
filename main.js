// save https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.d.ts in /modules/ folder to get type hint
// @ts-check
/// <reference types="./vscode.d.ts"/>
/**@typedef {{v:number,timestamp:string,description:string,requester:string,reviewRef:string,baseCommit:string,targetRef:string,reviewers:string[],alias?:string}} ReviewObj*/
/**@typedef {{v:number,timestamp:string,description:string,author:string, resolved?:boolean,parent?:string,original?:string,location?:{commit?:string,path?:string,range?:{startLine:number,startColumn?:number,endLine?:number,endColumn?:number}}}} CommentObj*/
/**@typedef {{body:CommentObj,blob:string,sha1:string,review:ReviewItem,blobs:string[]}} CommentItem */
/**@typedef {{body:ReviewObj,blob:string,sha1:string,noteRef:string,treeRef:string}} ReviewItem */
/**@typedef {{glob:string,match:string,label:string}} CheckGlobObj */
/**@typedef {{label:string,description:string,scopes:CheckGlobObj[],references:CheckGlobObj[],checkpoints:string[]}} CheckListConf */

// @ts-ignore
const vscode = require("vscode");
// @ts-ignore
const crypto = require('crypto');
// @ts-ignore
const child_process = require('child_process');

exports.activate = async function (/** @type {vscode.ExtensionContext} */context) {
	const rootdir = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
	if (!rootdir)return;
	const appraise = new Appraise({ vscode, crypto, context, child_process, rootdir });

}

class Appraise {
	/** @param {{ vscode:vscode, crypto:import("crypto"), context:vscode.ExtensionContext, child_process:import("child_process"), rootdir:string}}_ */
	constructor({ vscode, crypto, context, child_process, rootdir }) {
		this.vscode = vscode;
		this.child_process = child_process;
		this.rootdir = rootdir;
		this.context = context;
		this.crypto = crypto;
		this.treeChange = new vscode.EventEmitter();
		this.context.subscriptions.push(
			this.view = this.vscode.window.createTreeView('appraise.tree', { treeDataProvider: this.treeDataProvider(), canSelectMany: false }),
			this.vscode.commands.registerCommand("appraise.synchro", () => this.synchro()),
			this.vscode.commands.registerCommand("appraise.create", () => this.create()),
			this.vscode.commands.registerCommand("appraise.toggle", (arg) => this.toggle(arg)),
			this.vscode.commands.registerCommand("appraise.comment", (arg) => this.comment({ ...arg })),
			this.vscode.commands.registerCommand("appraise.resolve", (arg) => this.comment({ ...arg, resolved: true })),
			this.vscode.commands.registerCommand("appraise.unresolve", (arg) => this.comment({ ...arg, resolved: false })),
		);
	}
	#resolveIcon = {
		undefined: ["", "black"],
		true: ['M3,7L0,4L1,3L3,5L7,1L8,2', "green"],
		false: ['M0,1L1,0L8,7L7,8M1,8L0,7L7,0L8,1', "red"],
	}
	#resolveLabel = {
		undefined: undefined,
		true: "resolved",
		false: "UNRESOLVED"
	}
	#ref_reviews = 'refs/notes/devtools/reviews';
	#ref_discuss = 'refs/notes/devtools/discuss';
	/**@type {ReviewItem|undefined} current review being displayed in editor Threads */
	#currentReview = undefined;
	ico2uri = (ico, fill = "white") => this.vscode.Uri.from({ scheme: "data", path: `image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" fill="${fill}" viewBox="0 0 8 8"><path d="${ico}"></path></svg>` })
	// on win: absPath format is /c:/project, but rootdir (from git) use C:/project/a.txt => unify absPath to rootdir format then remove basedir to get a.txt
	// TODO: use this.vscode.workspace.asRelativePath ?
	relativ = (/**@type {string}*/absPath) => absPath.replace(/^\/[a-z]:\//, (m) => m.slice(1).toUpperCase()).replace(this.rootdir + '/', '');
	namespace = (ref, remoteName = "origin") => ref.replace('/notes/', `/notes/remotes/${remoteName}/`);
	toThreadComment = (/**@type {CommentObj} */body, /**@type {String}*/sha1) => /**@type {vscode.Comment} */({
		body: new this.vscode.MarkdownString(body.description, true),
		author: { name: body.author, iconPath: this.ico2uri(...this.#resolveIcon[body.resolved]) },
		label: sha1,
		contextValue: this.#resolveLabel[body.resolved],
		timestamp: new Date(1000 * +body.timestamp),
		mode: 1 //1:preview 0:editing
	})
	sha1 = (/**@type {string}*/values) => this.crypto.createHash("sha1").update(Buffer.from(values)).digest('hex');
	vscode2appraise = (/** @type {vscode.Range} */r) => ({ startLine: r.start.line, startColumn: r.start.character, endLine: r.end.line, endColumn: r.end.character });
	appraise2vscode = ({ startLine = 0, startColumn = 0, endLine = 0, endColumn = 0 }) => new this.vscode.Range(startLine, startColumn, endLine, endColumn);
	async git(/**@type {string[]}*/args) {
		console.log(["git", ...args].join(' '))
		const proc = this.child_process.spawnSync('git', args, { cwd: this.rootdir });
		if (proc === null || proc.status) throw `git ${args.join(' ')}\n${proc.status} : ${proc.stderr.toString()}`;
		return (s => s ? s.split('\n') : [])(proc.stdout.toString().trim());
	}
	commentIcon(/**@type {CommentItem}*/comment) {
		const fail = new this.vscode.ThemeIcon('error', { id: "testing.iconFailed" });
		const pass = new this.vscode.ThemeIcon('pass-filled', { id: "testing.iconPassed" });
		const none = new this.vscode.ThemeIcon('circle-large-outline', { id: "testing.iconUnset" });
		if (comment.body.description?.match?.(/^(SCOPE:|REF:)/)) return undefined; // resolved, but was never asked to be done => no/default icon
		if (comment.body.resolved === true) return pass // self-resolved
		if (comment.body.resolved === false) return fail // self-fail
		//use the most recent (un)resolved children to find out it state
		const [last] = comment.blobs.map(b => JSON.parse(b)).filter(obj => obj.parent == comment.sha1 && obj.resolved !== undefined).sort((a, b) => b.timestamp - a.timestamp)
		return last?.resolved === undefined ? none : last.resolved ? pass : fail;
	}
	/**@return {vscode.TreeDataProvider} */
	treeDataProvider = () => ({
		onDidChangeTreeData: this.treeChange.event,
		getTreeItem: async (/**@type {{review:ReviewItem} & {comment:CommentItem}}*/arg) => {//{rev,tree} // TODO: store returned item to uncheck+refresh uppon double review check
			const md = (obj, sha) => new this.vscode.MarkdownString("```json\n" + JSON.stringify(obj, null, '\t') + "\n```\n---\n" + sha);
			if (arg.review) return {
				contextValue: "appraise",
				id: arg.review.sha1,
				label: arg.review.body.description,
				description: `${arg.review.body.baseCommit?.slice(0, 7)}..${arg.review.body.reviewRef}`, // arg.review.body.requester
				tooltip: md(arg.review.body, arg.review.sha1),
				collapsibleState: 1,
			};
			if (arg.comment) return {
				contextValue: !arg.comment.body.parent || arg.comment.body.parent == arg.comment.review.sha1 ? `npl.comment` : `npl.comment2`,
				id: arg.comment.sha1,
				label: arg.comment.body.description,
				tooltip: md(arg.comment.body, arg.comment.sha1),
				iconPath: this.commentIcon(arg.comment),
				command: arg.comment.body.location?.path ?
					{ title: "open", command: "vscode.open", arguments: [this.vscode.Uri.parse(`file:${this.rootdir}/${arg.comment.body.location.path}#${(arg.comment.body?.location?.range?.startLine || 0) + 1 || ''}`)] } :
					undefined,//{ title: "comment", command: "appraise.comment", arguments: [{ comment: arg.comment }] },
				resourceUri: arg.comment.body.location ? this.vscode.Uri.file(`${this.rootdir}/${arg.comment.body.location.path}`) : undefined,
				collapsibleState: arg.comment.blobs.map(e => JSON.parse(e)).filter(f => f.parent == arg.comment.sha1).length ? 1 : 0
			};
			console.log({ getItem: arg })
			return {}
		},
		/** 
		 * @param {undefined | {review:ReviewItem} & {comment:CommentItem}} arg
		 * @return {Promise<{comment:CommentItem}[] | {review:ReviewItem}[]>} */
		getChildren: async (arg) => {
			if (!arg) return (await Promise.all((await this.git(["notes", "--ref", this.#ref_reviews])).map((e = "") => e.split(' ')).map(async ([noteRef, treeRef]) =>
				(await this.git(["notes", "--ref", this.#ref_reviews, "show", treeRef]).catch(_ => [""])).filter(String)
					.map(blob => ({ review: { body: JSON.parse(blob), blob, sha1: this.sha1(blob), noteRef, treeRef } }))
			))).flat();
			if (arg.review) return (await this.git(["notes", "--ref", this.#ref_discuss, "show", arg.review.treeRef]).catch(_ => [""])).filter(String)
				.map((blob, _, blobs) => ({ comment: { body: JSON.parse(blob), blob, sha1: this.sha1(blob), review: arg.review, blobs } }))
				.filter(({ comment }) => !comment.body.parent || comment.body.parent == arg.review.sha1)
			if (arg.comment) return (await this.git(["notes", "--ref", this.#ref_discuss, "show", arg.comment.review.treeRef]).catch(_ => [""])).filter(String)
				.map((blob, _, blobs) => ({ comment: { body: JSON.parse(blob), blob, sha1: this.sha1(blob), review: arg.comment.review, blobs } }))
				.filter(({ comment }) => comment.body.parent == arg.comment.sha1)
			console.log({ bad_getChildren: arg })
			return []
		},
		async getParent(element) { },//need for reveal() to work
		//async resolveTreeItem(item, element) { return {} },
	})
	fileMatches = async (/**@type {vscode.Uri}*/uri, regexp = "") => {
		const docu = await this.vscode.workspace.openTextDocument(uri);
		return [...docu.getText().matchAll(new RegExp(regexp, "mgd"))].map(m =>
			[this.relativ(uri.path), m[1], ...m.indices ? m.indices[1].map(e => docu.positionAt(e)).map(pos => ([pos.line, pos.character])).flat() : []].join('#')
		);
	}
	globToOption = async (/**@type {CheckGlobObj[]}*/scanObjs) => {
		const results = /**@type {string[]} */([])
		for (const scope of scanObjs) {
			if (scope.label) results.push(scope.label)
			else if (scope.glob) {
				for (const uri of await this.vscode.workspace.findFiles(scope.glob)) {
					results.push(this.relativ(uri.path), ...scope.match ? await this.fileMatches(uri, scope.match) : [])
				}
			}
		}
		return results;
	}
	async synchro() {
		this.view.description = "syncing...";
		this.view.message = "";//flush any previous error
		try { // git push may fail if someone rewrote history => catch
			for (const ref of [this.#ref_reviews, this.#ref_discuss]) {
				if (await this.git(["ls-remote", "--exit-code", "origin", ref]).catch(_ => false)) {
					await this.git(["fetch", "origin", ref + ":" + this.namespace(ref)]);
					await this.git(["notes", "--ref", ref, "merge", "--strategy", 'cat_sort_uniq', this.namespace(ref)]);
					await this.git(["push", "origin", ref]); // show-ref
				} else {
					await this.git(["push", "origin", ref]).catch(e => this.view.description = `empty ${ref}`); // first push (possibly empty)
				}
			}
			this.view.description = `Synced: ${new Date().toISOString().slice(11, 19)} UTC`;
			this.treeChange.fire(undefined)
		} catch (e) {
			this.view.message = e;
		}
	}
	async create(type = "request", ref = this.#ref_reviews, base = { $schema: `https://raw.githubusercontent.com/google/git-appraise/refs/heads/master/schema/${type}.json`, timestamp: String(+new Date() / 1000 | 0), v: 0 }) {
		const tmpUri = this.vscode.Uri.file(this.child_process.spawnSync('mktemp', ['--tmpdir', `XXXXXXXXXX.json`]).stdout.toString().trim());//TODO: fail on windows
		await this.vscode.workspace.fs.writeFile(tmpUri, Buffer.from(JSON.stringify(base, null, '\t')));
		const document = await this.vscode.workspace.openTextDocument(tmpUri);
		await this.vscode.window.showTextDocument(document);
		const watcher = this.vscode.workspace.onDidSaveTextDocument((d) => {
			if (d !== document) return;
			let obj = undefined;
			try { obj = JSON.parse(document.getText()) } catch (_) { }//TODO: also validate against Schema
			if (obj === undefined) return this.vscode.window.showErrorMessage("Invalid JSON. Fix and Save again");
			this.vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			watcher.dispose();
			const {$schema,...blob} = obj;
			this.git(["notes", "--ref", ref, "append", "-m", JSON.stringify(blob)]).then(() => {
				this.view.reveal(null, { focus: true, expand: true });
				this.synchro();
			});
		})
	}
	async toggle(/**@type {{review:ReviewItem}}*/{ review }, toggle = false) {
		if (!toggle) {
			const msg = `Reviews [${review.treeRef.slice(0, 7)}]`
			this.#currentReview = msg == this.view.title ? undefined : review;
			this.view.title = msg == this.view.title ? "Reviews" : msg;
			this.view.message = "";
		}
		if (!this.#currentReview) return this.commentCtrl?.dispose();
		/**@type {CommentItem[]} */
		const comments = (await this.git(["notes", "--ref", this.#ref_discuss, "show", review.treeRef])).filter(String)
			.map((blob, _, blobs) => ({ body: JSON.parse(blob), sha1: this.sha1(blob), blob, blobs, review: review }))
		this.commentCtrl?.dispose();
		this.commentCtrl = this.vscode.comments.createCommentController(`appraise`, `NPL Review`);
		this.commentCtrl.options = { placeHolder: "Markdown Comment...\nUse Ctrl+Enter to submit", prompt: "Add a comment..." }
		this.commentCtrl.commentingRangeProvider = { provideCommentingRanges: (document) => ['output'].includes(document.uri.scheme) ? [] : [new this.vscode.Range(0, 0, document.lineCount - 1, 0)] } //TODO only allow in review scope ?
		const threads = comments
			.filter(comment => comment.body.location?.path && (!comment.body.parent || comment.body.parent == comment.review.sha1))
			.map(comment => this.commentCtrl?.createCommentThread(
				this.vscode.Uri.file(this.rootdir + '/' + comment.body.location?.path),
				comment.body.location?.range ? this.appraise2vscode(comment.body.location.range) : new this.vscode.Range(1, 1, 2, 2),
				[this.toThreadComment(comment.body, comment.sha1), ...comments.filter(com => com.body.parent == comment.sha1).map(c => this.toThreadComment(c.body, c.sha1))]
			))
		threads.forEach(thread => thread && (thread.state = thread.comments.filter(c => c.contextValue).reverse()[0]?.contextValue == this.#resolveLabel[true] ? 1 : 0))
		const [head] = await this.git(["rev-parse", "HEAD"]);
		const [dest] = await this.git(["ls-remote", "origin", review.body.reviewRef]).then(br => br.map(b => b.split('\t')[0])).catch(_ => ['']);
		if (head != dest) this.view.message = `⚠️ your HEAD (${head?.slice(0, 7)}) is not checkout on ${review.body.reviewRef} (${dest?.slice(0, 7)})`;
	}
	/** @param {(vscode.CommentReply & { resolved?:boolean } & {comment?:CommentItem} & {review?:ReviewItem} )}_ */
	async comment({ text, thread, resolved, review, comment }) {
		if (comment || review) { //add comment from review sidebar => show inputbox
			const res = await this.vscode.window.showQuickPick(Object.values(this.#resolveLabel).map(String), { ignoreFocusOut: true, title: "resolve state" });
			if (res === undefined) return;// press esc
			resolved = res === String(this.#resolveLabel[undefined]) ? undefined : res === this.#resolveLabel[true];
			text = await this.vscode.window.showInputBox({ ignoreFocusOut: true, title: review ? "Comment" : "Reply" }) || "";
			if (!res) return;
		}

		const [author] = await this.git(['config', 'user.email']);
		const discuss = /**@type {CommentObj} */{
			timestamp: `${+new Date() / 1000 | 0}`,
			author,
			description: text.replaceAll(/\r/g, ''),
			resolved,
			location: comment ? comment.body.location : thread ? {
				path: this.relativ(thread.uri.path),
				commit: (await this.git(["rev-parse", "HEAD"]))[0],
				range: thread.range && this.vscode2appraise(thread.range)
			} : undefined,
			parent: comment?.sha1 || thread?.comments[0]?.label || review?.sha1 || this.#currentReview?.sha1,
			original: undefined,
			v: 0,
		};
		const blob = JSON.stringify(discuss);
		if (thread) {
			thread.comments = [...thread.comments, this.toThreadComment(discuss, this.sha1(blob))];
			thread.label = this.#resolveLabel[resolved];
			thread.collapsibleState = 1;
			if (resolved !== undefined) thread.state = resolved ? 1 : 0;
			this.vscode.commands.executeCommand('workbench.action.focusCommentsPanel');
		}
		const ref = review?.treeRef || comment?.review?.treeRef || this.#currentReview?.treeRef;
		await this.git(["notes", "--ref", this.#ref_discuss, "append", "-m", blob, ref || '?']);
		if (!thread && this.#currentReview) this.toggle({ review: this.#currentReview }, true);
		await this.synchro();
	}
}
