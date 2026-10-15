/**
 * paths.mjs - where this checkout's data lives. The JavaScript twin of `src/paths.py`.
 *
 * WHY THIS EXISTS. `src/paths.py` holds the single definition of the `ATS_DATA_DIR` setting, and the two
 * `.mjs` files that read configuration used to spell the directory out themselves (`join(ROOT, "data", ...)`
 * in one, a bare `"data/form_specs/..."` relative to the working directory in the other). A Node script
 * that computes the path its own way is a second definition: set `ATS_DATA_DIR` and half the toolkit reads
 * one directory while the rest reads another, with no error to show for it.
 *
 * ROOT      the repository root, from this file's own location (`src/paths.mjs` is one level down).
 * DATA_DIR  `$ATS_DATA_DIR` when it is set, otherwise `ROOT/data`.
 *
 * The variable is read HERE AND NOWHERE ELSE, at module load, so every importer in a process agrees.
 * A script that cannot import a sibling module (one pasted into a page, say) is the exception, and it
 * says so where it reads the variable, naming this file.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DATA_DIR = process.env.ATS_DATA_DIR ? resolve(process.env.ATS_DATA_DIR) : join(ROOT, "data");
