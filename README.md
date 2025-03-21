# OnlineSales CMS VSCode Extension

This extension allows developers and content creators to seamlessly work with OnlineSales CMS content directly within VSCode, leveraging Git version control and tools like Copilot for content creation.

## Features

- **Pull content** from OnlineSales CMS into your local workspace
- **Edit content** in convenient `.mdx` format with full VS Code features
- **Create new content** with easy scaffolding 
- **Push content back** to OnlineSales CMS via its REST API
- **Manage media assets** used in your content

## Getting Started

### Prerequisites

- Visual Studio Code 1.98.0 or higher
- An active OnlineSales CMS account with API access
- Access token for API authentication

### Setup

1. Install the extension from the VS Code marketplace
2. Open a folder where you want to work with your content
3. Run the command `OnlineSales: Initialize Workspace` to set up the folder structure
4. Run `OnlineSales: Authenticate` to connect to your OnlineSales instance

### Basic Workflow

1. **Pull content**: Run `OnlineSales: Pull Content` to download your existing content
2. **Edit locally**: Content is stored as `.mdx` files for the body and `.json` files for metadata
3. **Create new content**: Use `OnlineSales: New Content` to scaffold new posts or pages
4. **Push changes**: Run `OnlineSales: Push Content` to upload your changes back to OnlineSales CMS

## Commands

| Command | Description |
|---------|-------------|
| **OnlineSales: Initialize Workspace** | Sets up the workspace folder structure and configuration |
| **OnlineSales: Authenticate** | Authenticates with the OnlineSales API |
| **OnlineSales: Pull Content** | Downloads content from the CMS to local files |
| **OnlineSales: New Content** | Creates a new content scaffold locally |
| **OnlineSales: Push Content** | Uploads local content changes back to the CMS |

## Folder Structure

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
