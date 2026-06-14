const { ipcRenderer } = require('electron');

ipcRenderer.on('init', (_, { autoLaunch }) => {
  document.getElementById('check').style.visibility = autoLaunch ? 'visible' : 'hidden';
});

document.getElementById('auto-launch').addEventListener('click', () => {
  ipcRenderer.send('tray-toggle-autolaunch');
  const check = document.getElementById('check');
  check.style.visibility = check.style.visibility === 'hidden' ? 'visible' : 'hidden';
});

document.getElementById('quit').addEventListener('click', () => {
  ipcRenderer.send('tray-quit');
});

window.addEventListener('blur', () => window.close());
