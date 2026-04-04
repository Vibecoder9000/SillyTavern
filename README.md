# SillyTavern (Vibecoder Fork)

LLM Frontend for Power Users

---

## Fork Features

This fork adds significant enhancements to SillyTavern while staying synced with upstream staging. Below is a comprehensive list of features unique to this fork.

### Native Tool Calling System

A complete tool calling infrastructure that enables LLMs to interact with your system directly:

- **Browser Automation** - Full Playwright-based browser control with persistent sessions per user
  - Navigate to URLs, click elements, fill forms, scroll pages
  - Screenshot capture with coordinate grid overlay for element targeting
  - Execute JavaScript on pages
  - Download files from web pages
  - Multiple concurrent sessions with automatic cleanup
  - Loop detection to prevent repetitive actions

- **Python Execution** - Run Python scripts with live streaming output
  - Per-user sandboxed execution environment
  - Configurable timeout (default 2 minutes, max 15 minutes)
  - Automatic Python launcher detection (python3, python, py)
  - Streaming stdout/stderr back to the UI

- **Shell/PowerShell Execution** - Execute system commands with live output streaming
  - Command denylist for safety (rm, del, chmod, etc.)
  - UTF-8 encoding support on Windows
  - Real-time output streaming

- **Image Generation** - Integration with Stable Diffusion WebUI
  - Generate images via txt2img API
  - Automatic saving to user's sandbox directory

- **File Operations** - Sandboxed file read/write capabilities
  - Read files (supports array of paths for batch reading)
  - Write files to sandbox directory
  - Download files from sandbox to user

- **User Interaction** - Ask user for input mid-conversation
  - Present questions with options or free-form input
  - Wait for user response before continuing

- **Bio/Context Tool** - Retrieve character and persona information dynamically

### Enhanced Background Gallery (mostly pushed to staging by now)

A complete overhaul of the background image selector:

- **Folder Organization** - Create and manage folders for backgrounds
  - Drag-and-drop to organize
  - Folder thumbnails
  - Bulk selection mode

- **Starred Backgrounds** - Mark favorite backgrounds
  - Server-side persistence via `backgrounds.json`
  - Visual indicators (white border, starred section)

- **Fuzzy Search** - Quick filtering of backgrounds by name
  - Persistent search results
  - Natural sorting (handles numbered files correctly)

- **Justified Gallery Layout** - Improved visual presentation
  - Aspect-ratio aware thumbnail display
  - Smooth loading with placeholders
  - Mobile-optimized layout with larger thumbnails

- **Video Background Support** - Full video background functionality
  - Automatic static thumbnail generation for videos
  - Drag-and-drop video upload

- **Performance Improvements**
  - Lazy loading of thumbnails
  - WebP thumbnail generation for faster loading
  - Configurable thumbnail resolution via `config.yaml`
  - Progress bar during thumbnail generation
  - Chrome/Firefox performance optimizations

- **UI Enhancements**
  - Lock button to prevent accidental changes
  - Jump to top button
  - Rename with conflict resolution (appends number)
  - Date sorting option
  - Mobile-friendly popup design

### Per-User Sandbox System

Isolated workspace system for multi-user deployments:

- **User Isolation** - Each user gets their own sandbox directory
- **Workspace Switching** - UI to switch between workspaces
- **Character-Based Workspaces** - Optional per-character sandboxes
- **File Serving** - Media in uploads directory served to HTML

### File Upload/Download System

Enhanced file handling capabilities:

- **Upload to Sandbox** - Upload files from LLM tools to user's sandbox
- **Download from Sandbox** - Retrieve files back to the user
- **Group Upload Fix** - Proper handling of group-based uploads
- **Proper Encoding** - UTF-8 and binary file support

### Additional Improvements

- **Workspace Switcher** - Always-enabled workspace switcher in UI
- **Tailscale Support** - Network configuration for Tailscale deployments
- **Character Avatar Thumbnails** - Non-blocking avatar extension loading
- **Reduced Tool Call Lag** - Performance improvements for tool calling responses
- **LLM Background Control** - Syntax for LLMs to set chat backgrounds via macro

---

## Installation

This fork follows the same installation process as upstream SillyTavern.

```bash
git clone https://github.com/Vibecoder9000/SillyTavern.git
cd SillyTavern
git switch staging
start.bat
```

---

## Upstream Resources

- Upstream GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## Fork Repository

- GitHub: <https://github.com/Vibecoder9000/SillyTavern>

## License

AGPL-3.0
