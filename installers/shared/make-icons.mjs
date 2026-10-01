// Draws Papeleria's favicon as the launcher's icon, with the image library
// the installation has just installed. The installers run it with the
// installed Node.js; when it fails, the launcher keeps the system's default
// icon and nothing else changes.
//
// Usage: node make-icons.mjs <app folder> png <file.png>          (Ubuntu, 256 pixels)
//        node make-icons.mjs <app folder> ico <file.ico>          (Windows, 16 to 256 pixels)
//        node make-icons.mjs <app folder> iconset <folder.iconset> (macOS, for iconutil)
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

const [app, kind, output] = process.argv.slice(2);
if (app === undefined || output === undefined || !['png', 'ico', 'iconset'].includes(kind)) {
  process.stderr.write('Usage: node make-icons.mjs <app folder> png|ico|iconset <output>\n');
  process.exit(2);
}

const sharp = createRequire(join(app, 'package.json'))('sharp');
const favicon = readFileSync(join(app, 'theme', 'marks', 'papeleria-favicon.svg'));

/** The favicon as a tile with rounded corners, `size` pixels square, with `margin` of the size left clear on each side. */
async function tile(size, margin) {
  const inner = Math.max(1, Math.round(size * (1 - 2 * margin)));
  const radius = Math.round(inner * 0.225);
  // The favicon's viewBox is 32 units square: 72 dpi draws it at 32 pixels.
  const art = await sharp(favicon, {density: (72 * inner) / 32}).resize(inner, inner).png().toBuffer();
  const corners = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${inner}"><rect width="${inner}" height="${inner}" rx="${radius}" ry="${radius}"/></svg>`);
  const rounded = await sharp(art).composite([{input: corners, blend: 'dest-in'}]).png().toBuffer();
  const offset = Math.floor((size - inner) / 2);
  return sharp({create: {width: size, height: size, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}})
    .composite([{input: rounded, left: offset, top: offset}])
    .png()
    .toBuffer();
}

/** A Windows icon file holding one PNG image for each size. */
function icoFile(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({size, png}, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

if (kind === 'png') {
  writeFileSync(output, await tile(256, 0.06));
} else if (kind === 'ico') {
  const images = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 256]) {
    images.push({size, png: await tile(size, 0.04)});
  }
  writeFileSync(output, icoFile(images));
} else {
  // macOS's icon grid: the tile is 824 of 1,024 pixels.
  mkdirSync(output, {recursive: true});
  for (const [size, name] of [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ]) {
    writeFileSync(join(output, name), await tile(size, 100 / 1024));
  }
}
