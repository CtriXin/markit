import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';

export type RuntimePage = {
  context: BrowserContext;
  page: Page;
};

export class BrowserRuntime {
  private browser: Browser | undefined;
  private pages = new Map<string, RuntimePage>();
  private inputSessions = new Map<string, CDPSession>();

  async getBrowser(): Promise<Browser> {
    this.browser ??= await chromium.launch();
    return this.browser;
  }

  async createPage(sessionId: string, viewport: { width: number; height: number; deviceScaleFactor: number; isMobile?: boolean }): Promise<Page> {
    await this.closeSession(sessionId);
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile ?? false
    });
    const page = await context.newPage();
    this.pages.set(sessionId, { context, page });
    return page;
  }

  getPage(sessionId: string): Page | undefined {
    return this.pages.get(sessionId)?.page;
  }

  async createCdpSession(sessionId: string): Promise<CDPSession | undefined> {
    const runtime = this.pages.get(sessionId);
    if (!runtime) return undefined;
    return runtime.context.newCDPSession(runtime.page);
  }

  async dispatchMouseWheel(sessionId: string, event: { x: number; y: number; deltaX: number; deltaY: number }): Promise<boolean> {
    const runtime = this.pages.get(sessionId);
    if (!runtime) return false;
    let client = this.inputSessions.get(sessionId);
    if (!client) {
      client = await runtime.context.newCDPSession(runtime.page);
      this.inputSessions.set(sessionId, client);
    }
    try {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: event.x,
        y: event.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: 0,
        pointerType: 'mouse'
      });
      return true;
    } catch (error) {
      this.inputSessions.delete(sessionId);
      await client.detach().catch(() => undefined);
      throw error;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const existing = this.pages.get(sessionId);
    if (!existing) return;
    this.pages.delete(sessionId);
    const inputSession = this.inputSessions.get(sessionId);
    this.inputSessions.delete(sessionId);
    await inputSession?.detach().catch(() => undefined);
    await existing.context.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await Promise.all([...this.pages.keys()].map((id) => this.closeSession(id)));
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
  }
}
