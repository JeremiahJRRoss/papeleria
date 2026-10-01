# Install Papeleria on macOS, Windows 11 or Ubuntu 26.04

Papeleria turns a folder of text, data and images into a deck, a comic or a printable document. This zip installs it on your own computer with one script for each system. The script puts everything Papeleria needs in one folder of your own, including its own copy of Node.js, adds a **Papeleria** entry to your Applications, Start menu or app grid, and adds the `papeleria` command for the terminal. It needs no administrator password and changes nothing outside your own account. Each system has an uninstaller that takes all of it away again; your pieces are never touched.

| System | Install | Remove |
| --- | --- | --- |
| macOS 14 or later, Apple silicon or Intel | `macOS/Install Papeleria.command` | `macOS/Uninstall Papeleria.command` |
| Windows 11, x64 or ARM64 | `Windows\Install Papeleria.cmd` | Settings > Apps > Installed apps, or `Windows\Uninstall Papeleria.cmd` |
| Ubuntu 26.04 desktop, x86_64 or ARM64 | `bash Ubuntu/install.sh` | `bash Ubuntu/uninstall.sh` |

What was tested, and how, is at the [end of this page](#what-was-tested). In short: the Ubuntu installer was run end to end on Ubuntu 24.04; the macOS and Windows installers have not yet been run on a Mac or a Windows PC, only exercised on Linux with the parts those systems add replaced by stand-ins.

## What is in the zip

| In `papeleria-<version>/` | What it is |
| --- | --- |
| `README.md` | This page |
| `papeleria-<version>.tgz` | Papeleria itself, the package `npm pack` makes |
| `macOS/`, `Windows/`, `Ubuntu/` | The installer and the uninstaller for each system |
| `shared/` | What the installers share: the launcher, the icon maker, and `node-runtime.txt`, the Node.js release the installers download with the SHA-256 of each file |
| `LICENSE`, `NOTICE.md`, `TRADEMARKS.md` | Papeleria's licence (Apache-2.0), its notices and its trademark terms |

Keep the folders together: each installer uses `shared/` and the tarball beside it.

## Before you start

| You need | |
| --- | --- |
| A supported system | macOS 14 or later; Windows 11; Ubuntu 26.04 desktop. On an earlier release that Node.js 22 still runs on (macOS 11 or later, Windows 10 1809 or later, another recent Ubuntu), the installer warns and carries on; on one it does not, it stops |
| Disk | About 250 MB for the installation, and as much again free while it installs, since the new installation is made beside the old one before it replaces it |
| Network, while installing | The installer downloads Node.js from `nodejs.org` (26 to 36 MB, depending on the system) and Papeleria's dependencies from the npm registry (`registry.npmjs.org`, about 30 MB). After that, making, editing and building pieces needs no network |
| A browser | The editor opens in your default browser: a current Chrome, Edge, Firefox or Safari |

No administrator password, and no Node.js of your own: the installer brings the one Papeleria is tested with. A Node.js you already have is left as it is and is not used.

### What the installer does

The four steps are the same on every system, and the installer prints each one:

1. **Node.js.** It downloads Node.js 22.23.3 for your system and processor from `nodejs.org`, and uses it only if its SHA-256 is the one written in `shared/node-runtime.txt`. That copy of Node.js is Papeleria's alone: it is not put on your PATH.
2. **Papeleria.** It unpacks `papeleria-<version>.tgz` and installs Papeleria's dependencies with `npm ci`, at exactly the versions the package pins (its `npm-shrinkwrap.json`), without running any package's install script. npm also downloads the image library, sharp, built for your system.
3. **A check.** It runs `papeleria --version`, loads the image library, and makes and builds a sample deck in a temporary folder.
4. **Putting it in place.** Only now does it replace an earlier installation, so a failure in any step leaves your computer as it was. Then it adds the `papeleria` command, puts its folder on your PATH, and adds the Papeleria launcher.

Before step 1 it lists what it will install and where, and asks `Install? [Y/n]`.

### Where it puts things

| | macOS | Windows 11 | Ubuntu |
| --- | --- | --- | --- |
| The installation | `~/.local/share/papeleria` | `%LOCALAPPDATA%\Programs\Papeleria` | `~/.local/share/papeleria` |
| The `papeleria` command | `~/.local/bin/papeleria` | `%LOCALAPPDATA%\Programs\Papeleria\bin\papeleria.cmd` | `~/.local/bin/papeleria` |
| Its folder on your PATH | A marked block in `~/.zprofile` (`~/.bash_profile` if your shell is bash) | Your user PATH, in the registry | A marked block in `~/.bashrc` (`~/.zshrc` if your shell is zsh) |
| The launcher | `~/Applications/Papeleria.app` | Start menu: Papeleria | App grid: Papeleria (`~/.local/share/applications/papeleria.desktop`) |
| For uninstalling | `Uninstall Papeleria.command` in the zip and in the installation | Settings > Apps > Installed apps | `uninstall.sh` in the zip and in the installation |

The PATH block is added only when the folder is not on your PATH already, and it looks like this, between two marker lines the uninstaller finds again:

```text
# >>> papeleria >>>
# Added by the Papeleria installer, so new terminals find the papeleria command.
# The Papeleria uninstaller removes this block.
case ":${PATH}:" in *:'/Users/you/.local/bin':*) ;; *) export PATH='/Users/you/.local/bin':"${PATH}" ;; esac
# <<< papeleria <<<
```

Papeleria itself keeps one file outside your pieces, the key that signs its image caches: in `~/Library/Application Support/Papeleria` on macOS, `%LOCALAPPDATA%\Papeleria` on Windows and `~/.local/state/papeleria` on Ubuntu. It makes the key the first time a build makes images; the uninstallers remove it.

## macOS

### Install

1. Double-click the zip to extract it. You get a folder, `papeleria-<version>`, usually in Downloads.
2. Open **Terminal** (Applications > Utilities, or press Cmd Space and type Terminal). Type `bash` and a space, drag **Install Papeleria.command** from the `macOS` folder onto the Terminal window, and press Return.

   Why not double-click it? The script is not signed by an Apple developer, and it came from the internet, so macOS will not open it from Finder straight away. Run through `bash` like this, macOS reads it as text and asks nothing. To double-click it instead: on macOS 15 or later, double-click it once, click **Done** in the warning, then open System Settings > Privacy & Security, click **Open Anyway** beside the script's name, and confirm; on macOS 14, Control-click the script, choose **Open**, then **Open** again.
3. If macOS asks whether Terminal may access files in your Downloads folder, click **Allow**: the installer reads the zip's files from there.
4. Read the list the installer prints, and press Return to install. It ends with:

   ```text
   Papeleria 0.1.0 is installed.
     To start it:               Papeleria in Applications, Launchpad or Spotlight
     To remove it:              "Uninstall Papeleria.command" in the zip, or in Terminal:
                                bash ~/.local/share/papeleria/Uninstall\ Papeleria.command
     In a new terminal window:  papeleria --help
   ```

You can delete the zip and its folder afterwards.

### Start it

Open **Papeleria** from Applications (in your home folder), Launchpad or Spotlight. It opens a Terminal window with the [launcher's menu](#the-launcher). The first time you open a piece in your Documents or Desktop folder, macOS asks whether Terminal may access that folder: click **Allow**. The editor then opens in your default browser.

Papeleria.app is a small app the installer writes on your Mac; its one job is to open the launcher in Terminal. Keep it in `~/Applications`, and remove Papeleria with its uninstaller rather than by moving the app to the Trash, which would leave the installation behind.

### Remove it

Run **Uninstall Papeleria.command** from the zip the same way as the installer (`bash`, a space, drag the file, Return), or, without the zip, in Terminal:

```text
bash ~/.local/share/papeleria/Uninstall\ Papeleria.command
```

It lists what it will remove and asks `Remove Papeleria? [y/N]`.

## Windows 11

### Install

1. **Before extracting**, right-click the zip, choose **Properties**, tick **Unblock** at the bottom of the General tab, and click **OK**. This tells Windows you trust the download, so it does not treat each script inside as coming from the internet; on a PC with Smart App Control on, the scripts do not run otherwise. If there is no Unblock box, Windows has not marked the file, and there is nothing to do.
2. Right-click the zip and choose **Extract All**, then **Extract**.
3. Open the `Windows` folder and double-click **Install Papeleria.cmd**. If a blue window says "Windows protected your PC", click **More info**, then **Run anyway**.
4. A console window shows what the installer will install and where. Press Enter to install. It ends with:

   ```text
   Papeleria 0.1.0 is installed.
     To start it:               Papeleria in the Start menu
     To remove it:              Settings > Apps > Installed apps > Papeleria > Uninstall
     In a new terminal window:  papeleria --help
   ```

   Press any key to close the window. You can delete the zip and its folder afterwards.

`Install Papeleria.cmd` runs `install.ps1` with Windows PowerShell, for this run only allowing a script that is not signed (`-ExecutionPolicy Bypass`); it does not change your PC's PowerShell settings. On a PC whose organisation sets the execution policy, that setting wins and the script does not run: ask whoever manages the PC.

### Start it

Open the Start menu and choose **Papeleria** (type Papeleria if it is not in the list). A console window opens with the [launcher's menu](#the-launcher), and the Windows folder picker for choosing a piece. The editor opens in your default browser. It listens on this computer only (127.0.0.1), so Windows Firewall has nothing to ask about.

### Remove it

Open Settings > Apps > Installed apps, find **Papeleria**, and choose **Uninstall** from its menu. Or double-click **Uninstall Papeleria.cmd**, in the zip's `Windows` folder or in `%LOCALAPPDATA%\Programs\Papeleria`.

## Ubuntu 26.04

### Install

1. Extract the zip: right-click it in Files and choose **Extract**, or in a terminal, `unzip papeleria-<version>.zip`.
2. Open a terminal in the extracted folder: right-click the folder `papeleria-<version>` in Files and choose **Open in Terminal**.
3. Run:

   ```text
   bash Ubuntu/install.sh
   ```

   Read the list it prints, and press Enter to install. It ends with:

   ```text
   Papeleria 0.1.0 is installed.
     To start it:               Papeleria in the app grid (Show Apps, then type Papeleria)
     To remove it:              bash ~/.local/share/papeleria/uninstall.sh
     In a new terminal window:  papeleria --help
   ```

Do not run it with `sudo`: it installs into your own folders, and refuses to run as root.

On a fresh Ubuntu, `curl` may not be installed; the installer uses `wget` then, which Ubuntu has.

### Start it

Open **Show Apps** and choose **Papeleria**. It opens a terminal window with the [launcher's menu](#the-launcher), and a folder picker for choosing a piece. The editor opens in your default browser.

### Remove it

```text
bash ~/.local/share/papeleria/uninstall.sh
```

or `bash Ubuntu/uninstall.sh` from the zip. It lists what it will remove and asks `Remove Papeleria? [y/N]`.

## The launcher

Papeleria in your Applications, Start menu or app grid opens a terminal window with this menu:

```text
Papeleria 0.1.0

  1  Open a piece in the editor
  2  Make a new deck
  3  Make a new comic
  4  Make a new document
  q  Quit

Type 1, 2, 3, 4 or q, then press Return:
```

- **1** shows a folder picker: choose the piece's folder, the one that holds `papeleria.yaml`.
- **2, 3 and 4** show a folder picker for where the new piece goes. An empty folder becomes the piece itself (the picker's New Folder button makes one); any other folder gets the piece in a new folder inside it, whose name the launcher asks for (`my-deck` if you just press Return). Papeleria then makes the piece from its template's sample.

Either way the editor starts, the launcher prints its address, and your browser opens it. The user manual's [First piece](../docs/USER_MANUAL.md#first-piece) walks through the editor. **The editor runs as long as this window is open**: press Ctrl C in it, or close the window, to stop it. Save in the editor first.

Where the system shows no folder picker (Ubuntu without zenity, for example), the launcher asks you to drag the folder onto the window or type its path instead.

## The papeleria command

After installing, open a **new** terminal window (Terminal, PowerShell or Windows Terminal, or Ubuntu's terminal) and the `papeleria` command is there:

```text
papeleria --version
papeleria new deck my-deck
papeleria check my-deck
papeleria build my-deck
papeleria edit my-deck
```

A terminal window that was already open keeps its old PATH; on Ubuntu, logging out and in again also works. The installation guide's [Verify the installation](../docs/INSTALLATION.md#verify-the-installation) shows what to expect from each command, and `papeleria --help` lists them all.

## Options

The installers ask one question and need no options. These are for scripted and managed installations:

| macOS and Ubuntu | Windows (`install.ps1`) | Does |
| --- | --- | --- |
| `--yes` | `-Yes` | Installs without asking |
| `--tarball FILE` | `-Tarball FILE` | Installs this `papeleria-<version>.tgz` rather than the one beside the folders |
| `--no-launcher` | `-NoLauncher` | Leaves out Papeleria.app, the Start menu entry or the app grid entry |
| `--no-path` | `-NoPath` | Leaves your shell startup files, or your user PATH, alone |
| `--help` | `-Help` | Prints the options |

On Windows, give options through `Install Papeleria.cmd`, which passes them on: `"Install Papeleria.cmd" -Yes`.

The uninstallers take `--yes` (`-Yes`) and `--keep-state` (`-KeepState`), which keeps Papeleria's key for its image caches.

`PAPELERIA_NODE_MIRROR`, set in the environment, names a mirror of `https://nodejs.org/dist` to download Node.js from, such as your organisation's. The file must still have the SHA-256 in `node-runtime.txt`, so a mirror cannot change what is installed.

## Updating

Run the installer from the new version's zip. It installs the new version beside the old one, checks it, and only then replaces the old one; your pieces are not touched. If the editor is running, the installer asks you to stop it first.

To go back, run the installer from the older zip.

## What the uninstaller removes, and what it leaves

It removes the installation folder, the `papeleria` command, the PATH block or PATH entry the installer added (and nothing else in that file), the launcher, the Settings entry on Windows, and Papeleria's installation key. Each is removed only if it is the one the installer made: a file of the same name that the installer did not write is left alone.

It leaves your pieces as they are, wherever they are. In each piece, `dist/` and `.papeleria/` are generated: delete them yourself if you no longer want them (`.papeleria/` also holds the editor's backups). It also leaves the folders it may have made that other programs use too, such as `~/Applications` or `~/.local/share/applications`, even when they are empty.

## If something goes wrong

Every message the installers print when they stop begins `The installer stopped:` and says what to do.

| What happens | What to do |
| --- | --- |
| macOS: "cannot be opened because it is from an unidentified developer", or "Apple could not verify" | Run it through `bash` in Terminal, as [Install](#install) says; or allow it once in System Settings > Privacy & Security |
| Windows: "Windows protected your PC" | Click **More info**, then **Run anyway** |
| Windows: nothing happens, or "running scripts is disabled on this system" | Unblock the zip before extracting it (step 1 on Windows), then extract it again. On a managed PC, the organisation's policy decides; ask whoever manages it |
| `could not be downloaded` | Check the network. Behind a proxy: on macOS and Ubuntu, set `HTTPS_PROXY` for the installer; on Windows, the Node.js download uses the system's proxy settings. npm, which fetches the dependencies, reads `HTTPS_PROXY` or its own settings (`npm config set https-proxy`) |
| `the download's SHA-256 is ..., not ...` | The file that arrived is not the Node.js release the installer names, so it was not used. Try again later, or from another network. Do not edit `node-runtime.txt` to make it pass |
| `npm could not install Papeleria's dependencies` | npm's messages above it say why: usually the registry could not be reached. Your organisation's npm registry, proxy or certificate settings in `~/.npmrc` are used; set them there. Do not turn off certificate checks |
| `... exists and was not written by this installer` | Another installation of the `papeleria` command is in the way, often from `npm install -g`. Remove it (`npm uninstall -g papeleria`), then run the installer again |
| `Papeleria is running from ...` | The editor is open: stop it with Ctrl C in its window, or close the window, and run the installer or uninstaller again |
| `papeleria: command not found` (or "not recognized") | Open a new terminal window. On macOS and Ubuntu, check that the PATH block is in the file the installer named; on Windows, sign out and in again |
| Ubuntu: Papeleria in the app grid opens no terminal | Your desktop has no terminal it knows how to start. Run the launcher in a terminal: `bash ~/.local/share/papeleria/launcher.sh` |
| No folder picker appears | Drag the folder onto the terminal window, or type its path, when the launcher asks |
| No browser opens | Copy the address the launcher printed, the line that starts `http://127.0.0.1:`, into your browser. It works once; each time it opens the editor, Papeleria prints the next one |
| `E_SHARP_UNAVAILABLE` when a build makes images | The image library did not install for this computer. Run the installer again; if it happens again, keep the whole message, with your system and processor |

The user manual's [Diagnostics and troubleshooting](../docs/USER_MANUAL.md#diagnostics-and-troubleshooting) lists the editor's and the checks' own messages.

## For maintainers

### Making the zip

From the repository root, after `npm ci`:

```text
npm run package:installers
```

It builds the tool, packs the tarball as `npm pack` does (with `npm-shrinkwrap.json`, which the installers need), and writes to `release/` in the repository root, which git ignores:

- `papeleria-<version>.zip`, the file people download;
- `papeleria-<version>.tgz`, the same tarball, for anyone installing with npm;
- `SHA256SUMS`, for both, to publish beside them.

Before writing, `scripts/package-installers.mjs` checks what the installers depend on and stops on a problem: every Windows script is plain ASCII (Windows PowerShell 5.1 reads a script without a byte-order mark in the system's code page, and cmd.exe reads batch files in the console's); the macOS and Ubuntu scripts have LF line endings and start with `#!/bin/bash`; `node-runtime.txt` pins a Node.js 22 release and the SHA-256 of each archive an installer can download; and the tarball holds `npm-shrinkwrap.json`. The zip records Unix file modes, so the scripts arrive executable where the extractor honours them, and gives the Windows files CRLF line endings. `SOURCE_DATE_EPOCH`, when set, fixes the zip's timestamps. `--tarball FILE` packages an existing tarball; `--out DIR` writes elsewhere. `npm test` runs the same checks on the files in the repository.

### From a download of the repository

The installers also run from a copy of the repository, such as GitHub's **Code > Download ZIP**: with no tarball beside their folders, they build one first (`npm ci`, `npm run build`, `npm pack` at the repository root, with the Node.js they downloaded) and then install it as usual. Run them from `installers/`, for example `bash installers/Ubuntu/install.sh`. This takes longer and downloads the build tools as well; the build's `node_modules/` and `lib/` are removed again afterwards unless they were there before.

### Updating the pinned Node.js

The installers download exactly the Node.js release in `shared/node-runtime.txt`, which is how a release records the Node.js it was tested with. When Node.js publishes a 22.x release with security fixes:

1. Download the release's `SHASUMS256.txt` and `SHASUMS256.txt.sig` from `https://nodejs.org/dist/v<version>/`.
2. Check the signature against the Node.js release keys (the keyring is published in the `nodejs/release-keys` repository):

   ```text
   gpgv --keyring ./pubring.kbx SHASUMS256.txt.sig SHASUMS256.txt
   ```

   It must say `Good signature from` a Node.js releaser.
3. In `node-runtime.txt`, set the `version` line and replace the eight archive lines with the release's lines for the same eight files, and update the comment that records the signature.
4. Run `npm test`, which checks the file's form, then run an installer and build a piece.

### Licences

The installers distribute Papeleria's own package and nothing else: Node.js and every dependency are downloaded on the person's computer from their publishers, and each keeps its licence files there (Node.js's `LICENSE` in `runtime/`, each package's in its own folder). The tarball's `LICENSE`, `NOTICE.md`, `THIRD_PARTY.md` and `licenses/` sit in `app/`. The image library libvips (LGPL-3.0-or-later) stays the separate, replaceable library npm installs, in `@img/sharp-libvips-<platform>`. The PRD asks for a legal review before Papeleria ships as a desktop app; publishing this zip is the owner's decision to take with that review, and with the release gate `npm run check:licenses:release`.

### What was tested

On 2026-09-30, with Papeleria 0.1.0 and Node.js 22.23.3:

- **Ubuntu.** Run end to end on Ubuntu 24.04.4, x86_64, with no desktop, as an ordinary user: installing from a zip took about 11 seconds on that network and made a 249 MB installation; installing again replaced it; uninstalling left `~/.bashrc` byte for byte as it was before; installing from a download of the repository (a `git archive` zip, as GitHub's Download ZIP makes) built the tarball first, took about 22 seconds, and left the download without the `node_modules/` and `lib/` the build had made. The launcher's menu was driven with typed paths: a folder that is not a piece was refused, a new deck was made in a folder that was not empty, the editor started, and Ctrl C stopped it. `desktop-file-validate` accepts the app grid entry. Not run: Ubuntu 26.04 itself, a desktop session (the app grid entry opening a terminal, and the zenity folder picker), and ARM64.
- **macOS.** Not run on a Mac. The installer, the uninstaller and the launcher ran on Linux under bash 3.2.57 built from Apple's published source of the `/bin/bash` macOS ships, with only the commands macOS has on the PATH and stand-ins for `uname`, `sw_vers`, `sysctl` and `iconutil`: installing, installing again and uninstalling worked, `~/.zprofile` came back byte for byte, Papeleria.app's `Info.plist` parses, the icon's ten sizes were drawn, and the launcher made a deck in a folder holding only `.DS_Store`. Not run: Gatekeeper, Terminal, the `osascript` folder picker, `iconutil`, `lsregister`, and the macOS builds of Node.js and sharp.
- **Windows.** Not run on Windows. The three PowerShell scripts parse, and PSScriptAnalyzer 1.23.0, checking them against Windows PowerShell 5.1's profile, found no syntax or command they use that 5.1 lacks. The installer's and uninstaller's logic ran under PowerShell 7.4 on Linux with the registry, shortcut and Windows-version parts replaced by stand-ins: download, checksum, unpacking, `npm ci`, the checks, the PATH entry added and removed with the other entries left as they were, installing again and uninstalling. The launcher's menu ran there with typed paths. Not run: Windows PowerShell 5.1 itself, SmartScreen and Smart App Control, the `.cmd` files, the Start menu shortcut, the Settings entry, the folder picker, and the Windows builds of Node.js and sharp.

The runs a person makes on each system, with the browsers, belong in the release's platform record, `Dev_Docs/docs/user/a10-record.md` in the Dev_Papeleria repository.
