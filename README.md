# VSCode Appraise

Provide a [git appraise](https://github.com/google/git-appraise) Interface to VSCode to

![preview](https://github.com/user-attachments/assets/369f757b-2fbd-46ff-acbe-b22431f6d023)

- List `request` and `discuss` in a [tree view](https://github.com/microsoft/vscode-extension-samples/tree/main/tree-view-sample)
- Display discuss using [CommentThread](https://github.com/microsoft/vscode-extension-samples/tree/main/comment-sample)
- Create discuss/request object via JSON editor + JSON schemas

## Build

- `zip ./appraise.vsix main.js package.json`
- `code --install-extension ./appraise.vsix`