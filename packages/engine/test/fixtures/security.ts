import { nativeWorldFixtures, type NativeWorld } from "./native-worlds.js";

export function securityWorlds() {
  const fixtures = nativeWorldFixtures();
  const forget = (w: NativeWorld) => w.editSaved((state) => {
    delete (state.products[0] as { remote?: string }).remote;
  });
  return { world: fixtures.world, forget, close: fixtures.close };
}
