# Installation guide

[README](../README.md) · [User manual](USER_MANUAL.md) · [Architecture](ARCHITECTURE.md) · [Licensing](LICENSING.md)

For Papeleria 0.1.0 and manifest schema 1. The application lives at the root of the [repository](https://github.com/JeremiahJRRoss/papeleria/tree/main), and this guide is in its `docs/` folder.

## Choose an installation

| Route | Use it when | You need |
| --- | --- | --- |
| [Build from source](#build-from-source) | You want the current code or will contribute | Git, Node.js 22.x, npm |
| [Install a release tarball](#install-a-release-tarball) | The project has supplied a `papeleria-<version>.tgz` | Node.js 22.x and npm |
| [Use a desktop installer](#use-a-desktop-installer) | The project has supplied its installer ZIP, or you downloaded the source ZIP | The full extracted package and a network connection; the installer downloads its own Node.js |

Use files provided through this project's [repository](https://github.com/JeremiahJRRoss/papeleria) or [Releases](https://github.com/JeremiahJRRoss/papeleria/releases). No npm registry release is established by this documentation; the current package is marked private. The source route works without waiting for a named release asset to be offered.

## Requirements and platform status

| Requirement | Detail |
| --- | --- |
| Runtime for source/tarball routes | Node.js **22.x**, with npm; run `node --version` and `npm --version` |
| CLI platform targets | Windows 11 x64; macOS 14+ on Intel or Apple silicon; Ubuntu 24.04 x64 |
| Desktop installer targets | Windows 11 x64/ARM64; macOS 14+ Intel/Apple silicon; Ubuntu 26.04 desktop x64/ARM64 |
| Recorded installation evidence | Source and tarball workflows on Linux x64 with glibc. Ubuntu installer on Ubuntu 24.04.4 x64. Actual macOS, Windows, Ubuntu 26.04 desktop, and ARM64 acceptance remain pending |
| Browser | A recent Chrome, Edge, Firefox, or Safari. Test the actual browser and assistive technology you intend to support; automated browser tests do not constitute completed platform acceptance |
| Disk and permissions | A writable install location and piece folders. Allow roughly 250 MB for a desktop installation and that much additional space during an update; source dependencies and each piece's media/cache need more |
| Network | Required to download the runtime and npm dependencies. Editing and building an installed copy work offline |

Platform targets describe intended coverage, not completed certification. The installer currently pins **Node.js 22.23.3** and verifies its download against recorded SHA-256 values. Earlier source/tarball installation evidence used Node.js 22.22.2 and npm 10.9.7.

## Build from source

Install Node.js 22 using your normal approved software installation method. Obtain it from the [official Node.js site](https://nodejs.org/en/download) if needed. Install Git, open a new terminal, and verify that `node --version` begins with `v22.`.

```sh
git clone --branch main https://github.com/JeremiahJRRoss/papeleria.git
cd papeleria
npm ci
npm run build
node lib/src/cli/index.js --version
```

The current version prints `0.1.0`. `npm ci` uses the checked-in lockfile. The build compiles TypeScript and bundles browser clients into `lib/`. Run every npm command for the application from the repository root, **`papeleria`**.

Choose how to invoke the compiled tool:

| Method | Command and effect |
| --- | --- |
| Direct | `node lib/src/cli/index.js --help` from the repository root; from another folder use the absolute path to that file |
| Linked | `npm link` creates a `papeleria` command linked to this checkout; rebuild after changing source |
| Packed | `npm pack` creates `papeleria-0.1.0.tgz` in the repository root; install it using the next section |

`npm link` writes to npm's global prefix. If that prefix is not writable, use the direct command or a project-folder tarball installation. No administrator account is required.

## Install a release tarball

The examples use `papeleria-0.1.0.tgz`; substitute the exact filename supplied by the project. A tarball contains Papeleria, but npm still downloads its dependencies during installation.

### In a project folder

```sh
mkdir papeleria-work
cd papeleria-work
```

Copy the tarball into that folder, then run:

```sh
npm init -y
npm install --save-exact --omit=dev ./papeleria-0.1.0.tgz
npm exec --offline -- papeleria --version
npm exec --offline -- papeleria new deck my-deck
```

Use `npm exec --offline -- papeleria` in place of `papeleria` throughout the manual. `--offline` ensures the invocation uses the installed copy. Keep the tarball, `package.json`, and `package-lock.json` together so the `file:` dependency remains resolvable. Another connected computer can run `npm ci` in this folder.

### As a command for your account

```sh
npm install -g ./papeleria-0.1.0.tgz
papeleria --version
```

If npm reports `EACCES`, use the project-folder route. Alternatively, on macOS/Linux install to a writable prefix:

```sh
npm install -g --prefix ~/.local ./papeleria-0.1.0.tgz
~/.local/bin/papeleria --version
```

Add `~/.local/bin` to your shell's PATH to use the short command. `npm prefix -g` shows the global prefix. On Windows, if PowerShell refuses the npm `.ps1` shim, invoke `papeleria.cmd` or use Command Prompt.

## Use a desktop installer

Extract the entire application installer ZIP, `papeleria-<version>.zip`, into a normal folder. Keep `macOS/`, `Windows/`, `Ubuntu/`, `shared/`, and the tarball together.

| System | Run from the extracted installer folder | Start after installation |
| --- | --- | --- |
| macOS | In Terminal: `bash "macOS/Install Papeleria.command"` | Papeleria in your home Applications folder |
| Windows | Open `Windows\Install Papeleria.cmd` | Papeleria in the Start menu |
| Ubuntu | In a terminal: `bash Ubuntu/install.sh` | Papeleria in the app grid |

Read the proposed destination and press Enter at `Install? [Y/n]` to continue. The installer downloads a private runtime, checks its hash, installs pinned dependencies, checks the installation, and then puts it in place. It adds a launcher and a user-level command; it does not replace an existing system Node.js.

The Windows launcher invokes its bundled PowerShell script with a per-process execution-policy override; organization policy still takes precedence. Follow your organization's software approval process if execution is blocked. A download hash mismatch stops installation: retry a trusted download without editing the expected hash.

The installers also work from GitHub's **Code → Download ZIP** of the source. From the extracted repository root, use `installers/` before the paths above, for example:

```sh
bash installers/Ubuntu/install.sh
```

In this case the installer builds the tarball first using the runtime it downloads. The complete source tree must be present.

### Installed locations

| Item | macOS | Windows | Ubuntu |
| --- | --- | --- | --- |
| Application and private runtime | `~/.local/share/papeleria` | `%LOCALAPPDATA%\Programs\Papeleria` | `~/.local/share/papeleria` |
| CLI | `~/.local/bin/papeleria` | `%LOCALAPPDATA%\Programs\Papeleria\bin\papeleria.cmd` | `~/.local/bin/papeleria` |
| Launcher | `~/Applications/Papeleria.app` | Start menu | `~/.local/share/applications/papeleria.desktop` |

The installer adds a marked PATH block to the relevant shell startup file on macOS/Linux, or a user PATH entry on Windows. Open a **new terminal** afterward.

The launcher offers **Open a piece**, **Make a new deck**, **Make a new comic**, and **Make a new document**. Select a folder; an empty folder becomes the piece, while a nonempty destination receives a named subfolder. Without a graphical folder picker, type or drag the path into the terminal. Keep that terminal open while editing. Save first, then press Ctrl+C to stop.

For managed installation, macOS/Ubuntu scripts accept `--yes`, `--no-launcher`, and `--no-path`; the Windows `install.ps1` equivalents are `-Yes`, `-NoLauncher`, and `-NoPath`. `PAPELERIA_NODE_MIRROR` can select an approved mirror of Node's distribution directory; the pinned checksums still apply.

## Verify the installation

Run in a writable folder, substituting the invocation for your installation:

```sh
papeleria --version
papeleria new deck test-deck
papeleria check test-deck
papeleria build test-deck
papeleria edit test-deck
```

Expect version `0.1.0`, a sample deck, a check with zero errors, and a completed `test-deck/dist/index.html`. The sample contains five slides. Confirm the editor opens, save a small change, build again, and open the generated HTML. Exit with Ctrl+C. Exact byte counts vary with dependency and encoder versions.

If the browser does not open automatically, paste the **fresh address printed by `edit`** into a browser on the same machine. A launch address opens once and expires after two minutes; the terminal prints replacements. `PAPELERIA_NO_BROWSER` set to any nonempty value disables automatic opening.

## Offline and managed networks

Use approved npm registry, proxy, and certificate settings for installation. Keep TLS verification enabled and credentials out of piece files.

For an offline computer, prepare a project-folder installation on a connected machine with the same operating system, processor, C library where applicable, and Node.js 22. Verify a sample build there, then copy the whole installation, including `node_modules`, tarball, and lockfiles. Install Node.js 22 on the destination separately and verify again with `npm exec --offline -- papeleria --version`. A tarball by itself is insufficient offline.

The native image library must match the destination platform. Copying `node_modules` between macOS, Windows, Linux, or different processor architectures is not a portable installation method.

## Update and remove

Back up your source pieces and stop their editors before updating.

| Installation | Update | Remove |
| --- | --- | --- |
| Desktop | Run the installer from the new version's complete ZIP; it checks the new installation before replacing the old one | Use its uninstaller; Windows also offers Settings → Apps → Installed apps → Papeleria |
| Project tarball | Copy the new tarball into the project and repeat the local npm install command with that filename | `npm uninstall papeleria` in the project folder |
| Global tarball | Repeat the global install command with the new tarball and the same prefix | `npm uninstall -g papeleria`, with the same `--prefix` if used |
| Source checkout | From the repository root: `git pull --ff-only`, `npm ci`, `npm run build`; preserve local changes before pulling | Run `npm unlink -g papeleria` if linked, then remove the checkout after preserving any pieces stored inside it |

On macOS, the desktop uninstaller is `bash ~/.local/share/papeleria/Uninstall\ Papeleria.command`. On Ubuntu it is `bash ~/.local/share/papeleria/uninstall.sh`. The original installer ZIP also contains each uninstaller. It removes files and PATH entries it owns, plus the cache-signing key; it leaves your piece folders alone. `--keep-state` or Windows `-KeepState` retains that key.

Outside piece folders, Papeleria stores its cache-signing key in:

| System | Default state directory |
| --- | --- |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/papeleria` |
| macOS | `~/Library/Application Support/Papeleria` |
| Windows | `%LOCALAPPDATA%\Papeleria` |

`PAPELERIA_STATE_HOME` overrides that directory. Removing the key causes cached images to be regenerated. Inside each piece, `.papeleria/` contains caches **and editor backups**; after an interrupted build it can also contain the previous output. Complete recovery with a build and preserve needed backups before deleting it.

## Installation troubleshooting

| Symptom | Action |
| --- | --- |
| `papeleria` not found | Open a new terminal, check PATH, or use the direct/local invocation above |
| Cannot find `package.json` | Change to the repository root, `papeleria`, for source commands |
| Cannot find `lib/src/cli/index.js` | Run `npm ci` and `npm run build` in the repository root |
| Wrong Node engine | Select Node.js 22.x, reopen the terminal, and reinstall dependencies |
| `E_SHARP_UNAVAILABLE` | Reinstall dependencies on this machine with `npm ci`, or rerun the desktop installer; a foreign-platform copy cannot load its native image library |
| AVIF warning but WebP succeeds | The build is usable; this platform's encoder cannot write AVIF |
| Installer says an existing file is not its own | Identify and remove the earlier conflicting installation using its own uninstall method |
| Editor port occupied | Stop the earlier process, omit `--port`, or choose another port |
| No Ubuntu launcher terminal | Run `bash ~/.local/share/papeleria/launcher.sh` in a terminal |

For authoring errors and recovery, continue to the [user manual](USER_MANUAL.md#diagnostics-and-troubleshooting).
