import { join } from "node:path";
import { type BasouPaths, type BoardGlance, glanceBoard, readManifest } from "@basou/core";
import { DEFAULT_BOARD_PATH } from "../commands/board.js";

/**
 * The workspace's default board, glanced at for one line of its position: the
 * board.yaml `basou board` reads by default, which it reads only when the
 * manifest declares the workspace's own repo private. Null when there is
 * none, or the manifest cannot be read: a position never fails on a board,
 * which an experimental command wrote. Every writer of the position calls
 * this, so the line is there whichever wrote it last.
 */
export async function glanceDefaultBoard(
  root: string,
  paths: BasouPaths,
): Promise<BoardGlance | null> {
  try {
    const own = (await readManifest(paths)).repos?.find((repo) => repo.path === ".");
    if (own?.visibility !== "private") return null;
  } catch {
    return null;
  }
  return glanceBoard(join(root, DEFAULT_BOARD_PATH));
}
