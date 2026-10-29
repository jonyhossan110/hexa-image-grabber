// Hexa Image Grabber — options page logic.
const DEFAULTS = { minSize: 120, rootFolder: 'HexaImages', includeBg: true };

async function load() {
  const s = await chrome.storage.local.get(['settings', 'higRegistry']);
  const set = Object.assign({}, DEFAULTS, s.settings || {});
  document.getElementById('minSize').value = set.minSize;
  document.getElementById('rootFolder').value = set.rootFolder;
  document.getElementById('includeBg').checked = !!set.includeBg;
  const reg = s.higRegistry || { urls: {}, hashes: {} };
  const nu = Object.keys(reg.urls || {}).length, nh = Object.keys(reg.hashes || {}).length;
  document.getElementById('stats').textContent =
    'Saved-image history: ' + nu + ' image addresses and ' + nh + ' unique image fingerprints remembered. ' +
    'Those images are marked "Saved" in the popup and skipped as duplicates unless you select them on purpose.';
}

document.getElementById('save').addEventListener('click', async () => {
  const minSize = Math.max(1, parseInt(document.getElementById('minSize').value, 10) || DEFAULTS.minSize);
  const rootFolder = (document.getElementById('rootFolder').value || DEFAULTS.rootFolder)
    .replace(/[\\/:*?"<>|]+/g, '').trim() || DEFAULTS.rootFolder;
  const includeBg = document.getElementById('includeBg').checked;
  await chrome.storage.local.set({ settings: { minSize, rootFolder, includeBg } });
  document.getElementById('msg').textContent = '✅ Settings saved.';
});

document.getElementById('resetReg').addEventListener('click', async () => {
  await chrome.storage.local.set({ higRegistry: { urls: {}, hashes: {} } });
  document.getElementById('msg').textContent = 'History cleared — images can be downloaded fresh again.';
  load();
});

load();
