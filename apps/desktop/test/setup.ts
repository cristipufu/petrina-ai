import { beforeEach } from 'vitest';
import { Storage } from 'happy-dom';
// Rules and controllers opt into Node and must not acquire a browser as implicit setup.
if (typeof document !== "undefined") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // Node 25 also exposes a placeholder localStorage; use the browser environment's storage.
  Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true });
  // Recording mocks retain their DOM receivers. Tests that inspect scrolling own a scoped spy.
  Object.assign(HTMLElement.prototype, { scrollIntoView() {}, scrollTo() {} });

  // Each app render begins at its requested address; navigation must not leak between tests.
  beforeEach(() => history.replaceState(null, "", "/"));
}
