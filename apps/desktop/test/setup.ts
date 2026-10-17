import { vi } from 'vitest';
import { Storage } from 'happy-dom';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Node 25 also exposes a placeholder localStorage; use the browser environment's storage.
Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true });
vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {});
