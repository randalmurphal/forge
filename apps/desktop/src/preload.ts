import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@forgetools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const GET_WS_URL_CHANNEL = "desktop:get-ws-url";
const WSL_DISTROS_CHANNEL = "desktop:wsl-distros";
const WSL_CHECK_FORGE_CHANNEL = "desktop:wsl-check-forge";
const CONNECTION_CONFIG_CHANNEL = "desktop:connection-config";
const CONNECTION_TEST_CHANNEL = "desktop:connection-test";
const CONNECTION_SAVE_CHANNEL = "desktop:connection-save";
const CONNECTION_CLEAR_CHANNEL = "desktop:connection-clear";

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => ipcRenderer.sendSync(GET_WS_URL_CHANNEL) as string | null,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  checkForUpdate: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  // Connection management
  getConnectionConfig: () => ipcRenderer.invoke(CONNECTION_CONFIG_CHANNEL),
  testConnection: (wsUrl) => ipcRenderer.invoke(CONNECTION_TEST_CHANNEL, wsUrl),
  saveConnection: (config) => ipcRenderer.invoke(CONNECTION_SAVE_CHANNEL, config),
  clearConnection: () => ipcRenderer.invoke(CONNECTION_CLEAR_CHANNEL),
  // WSL
  getWslDistros: () => ipcRenderer.invoke(WSL_DISTROS_CHANNEL),
  checkWslForge: (distro) => ipcRenderer.invoke(WSL_CHECK_FORGE_CHANNEL, distro),
} satisfies DesktopBridge);
