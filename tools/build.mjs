import path from "node:path";
import { BP, RP, BUILDS, validateProject } from "./project.mjs";
import { writeAddonZip } from "./zip.mjs";

try {
    const { version } = validateProject();
    const output = path.join(BUILDS, `LilysMoney-v${version}.mcaddon`);
    const count = writeAddonZip(output, [
        [BP, "LilysMoneyBP"],
        [RP, "LilysMoneyRP"],
    ]);
    console.log(`Build complete: ${output} (${count} files)`);
} catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
}
