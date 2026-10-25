import { makeWorld, removeDir, type World } from "../support.js";

export function securityWorlds() {
const forget = (w: World) => w.editSaved((state) => {
  delete (state.products[0] as { remote?: string }).remote;
});
const worlds: World[] = [];
const world = async (...args: Parameters<typeof makeWorld>) => {
  const made = await makeWorld(...args);
  worlds.push(made);
  return made;
};
async function close() {
  for (const made of worlds) removeDir(made.dir);
 }
return { world, forget, close };
}
