/**
 * Connection Status panel.
 *
 * Opened from Game Settings → Foundry MCP Bridge → "Open Connection Status", or from a macro
 * with `game.modules.get('foundry-mcp-bridge').api?.openStatus()` / `foundryMCPBridge.openStatus()`.
 *
 * Shows whether this world is connected to the MCP server, whether it is the ACTIVE world
 * (the one Claude talks to) or on standby, and every world the server knows about, with a
 * button to make this world the active one.
 */

import { MODULE_ID } from './constants.js';
import { formatDiagnostics, STATUS_CHANGED_HOOK } from './bridge-status.js';

function bridge(): any {
  return (window as any).foundryMCPBridge;
}

/**
 * Defined lazily because `FormApplication` only exists once Foundry has loaded; the class is
 * created while settings are registered.
 */
export function defineConnectionStatusApp(): any {
  return class ConnectionStatusApp extends (FormApplication as any) {
    private statusHook: number | null = null;

    static get defaultOptions() {
      return foundry.utils.mergeObject((FormApplication as any).defaultOptions, {
        id: `${MODULE_ID}-connection-status`,
        title: 'Foundry MCP Bridge — Connection Status',
        template: `modules/${MODULE_ID}/templates/connection-status.html`,
        classes: ['mcp-status-window'],
        width: 520,
        height: 'auto',
        resizable: false,
        closeOnSubmit: false,
      } as any);
    }

    getData(): any {
      const vm = bridge().getStatusViewModel();
      return { ...vm, hasWorlds: vm.worlds.length > 0 };
    }

    activateListeners(html: JQuery): void {
      super.activateListeners(html);
      html.find('[data-action]').on('click', (event: JQuery.ClickEvent) => {
        event.preventDefault();
        void this.runAction(String(event.currentTarget.dataset.action));
      });

      // Re-render whenever the connection or the server's status changes.
      if (this.statusHook === null) {
        this.statusHook = (Hooks as any).on(STATUS_CHANGED_HOOK, () => {
          if ((this as any).rendered) void this.render(false);
        });
      }
    }

    async close(options?: any): Promise<void> {
      if (this.statusHook !== null) {
        (Hooks as any).off(STATUS_CHANGED_HOOK, this.statusHook);
        this.statusHook = null;
      }
      return super.close(options);
    }

    async _updateObject(): Promise<void> {
      // Nothing to save; the panel only has buttons.
    }

    private async runAction(action: string): Promise<void> {
      const b = bridge();
      try {
        switch (action) {
          case 'refresh':
            await this.render(false);
            break;
          case 'connect':
            await b.start();
            break;
          case 'disconnect':
            await b.stop();
            break;
          case 'make-active':
            b.requestSelectWorld();
            ui.notifications?.info('Asked the MCP server to make this world the active one.');
            break;
          case 'copy': {
            await navigator.clipboard.writeText(formatDiagnostics(b.getStatusViewModel()));
            ui.notifications?.info('Connection details copied to the clipboard.');
            break;
          }
        }
      } catch (error) {
        ui.notifications?.warn(error instanceof Error ? error.message : String(error));
      }
      if ((this as any).rendered) await this.render(false);
    }
  };
}
