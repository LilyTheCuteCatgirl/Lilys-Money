import { serverOptions } from "../settings/server.js";
import { getItemIconFromId } from "../ui/itemIcons.js";
import {
    shortId,
    loadJobs,
    getJobIcon,
    tell,
    saveJobsAllowEmptyOrWarn,
    getJobIconOptions,
    getJobIconByPresetIndex,
    saveJobsOrWarn,
    getJobIconPresetIndex,
    deepClone,
} from "./storage.js";
import { isAdmin } from "../commandSource.js";
import { getCurrentJobId, setJob } from "./rewards.js";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { formatCents, parseFloatToCents } from "../economy/formatting.js";
import { DEFAULT_JOBS } from "../defaults/jobs.js";

function getRewardRuleIcon(type, id) {
    if (type === "kill") {
        return getItemIconFromId(`minecraft:${shortId(id)}_spawn_egg`);
    }

    return getItemIconFromId(id);
}

export async function openJobRoot(player) {
    if (!serverOptions().jobs) return tell(player, "Jobs are disabled.");

    const jobs = loadJobs();
    const admin = isAdmin(player);

    const currentId = getCurrentJobId(player);
    const currentJob = currentId ? jobs.jobs.find((j) => j.id === currentId) : null;

    const visible = jobs.jobs.filter((j) => j.enabled !== false);

    const form = new ActionFormData()
        .title("§d§lJobs§r")
        .body(`§8Current job: §f${currentJob ? currentJob.name : "None"}\n§8Pick a job to view its rewards.\n`);

    if (admin) {
        form.button("§6§lEdit Jobs", "textures/ui/settings_glyph_color_2x");
    }

    for (const j of visible) {
        form.button(`§f§l${j.name}\n§r§8${j.description || "View rewards"}`, getJobIcon(j));
    }

    form.button(currentJob ? "§c§lLeave Job" : "§c§lClose", currentJob ? "textures/ui/cancel" : "textures/ui/cancel");

    const res = await form.show(player);
    if (res.canceled) return;

    if (admin && res.selection === 0) return openAdminJobsMenu(player);

    const offset = admin ? 1 : 0;
    const leaveIndex = offset + visible.length;

    if (res.selection === leaveIndex) {
        if (currentJob) {
            if (!setJob(player, null)) return;
            tell(player, "§aYou left your job.");
        }

        return;
    }

    const picked = visible[res.selection - offset];
    if (!picked) return;

    return openJobDetails(player, picked.id);
}

async function openJobDetails(player, jobId) {
    const jobs = loadJobs();

    const job = jobs.jobs.find((j) => j.id === jobId && j.enabled !== false);
    if (!job) return openJobRoot(player);

    const currentId = getCurrentJobId(player);
    const alreadyCurrent = currentId === job.id;

    const form = new ActionFormData()
        .title(`${job.name}§r`)
        .body(buildJobDetailsBody(job, currentId))
        .button(alreadyCurrent ? "§2§lAlready Your Job" : "§2§lJoin Job", alreadyCurrent ? "textures/ui/confirm" : getJobIcon(job))
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openJobRoot(player);

    if (res.selection === 0) {
        if (!alreadyCurrent) {
            if (!setJob(player, job.id)) return;
            tell(player, `§aYou are now a §f${job.name}§a.`);
        }

        return;
    }

    return openJobRoot(player);
}

async function openAdminJobsMenu(player) {
    const form = new ActionFormData()
        .title("§6§lJob Editor§r")
        .body("§8Manage jobs and rewards (saved per-world).")
        .button("§2§lAdd Job", "textures/ui/color_plus")
        .button("§e§lEdit Existing Job", "textures/ui/editIcon")
        .button("§c§lReset to Defaults", "textures/ui/refresh_light")
        .button("§4§lClear ALL Jobs", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return;

    if (res.selection === 0) return openAddJob(player);
    if (res.selection === 1) return openPickJobToEdit(player);
    if (res.selection === 2) return openResetJobsConfirm(player);
    if (res.selection === 3) return openClearJobsConfirm(player);

    return openJobRoot(player);
}

async function openClearJobsConfirm(player) {
    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§4§lClear ALL Jobs?")
        .body("§cThis will delete ALL jobs.\n" + "§8Players will have no jobs until you add new ones.\n\n" + "§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§4§lClear ALL Jobs", "textures/ui/trash");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openAdminJobsMenu(player);
    }

    const empty = { v: 2, jobs: [] };

    saveJobsAllowEmptyOrWarn(player, empty);
    tell(player, "§aAll jobs cleared.");

    return openAdminJobsMenu(player);
}

async function openAddJob(player) {
    const form = new ModalFormData()
        .title("Add Job")
        .textField("Job ID (no spaces)", "ex: fisher", { defaultValue: "" })
        .textField("Job Name", "ex: Fisher", { defaultValue: "" })
        .textField("Description", "shown in UI", { defaultValue: "" })
        .dropdown("Job icon", getJobIconOptions(), { defaultValueIndex: 0 })
        .toggle("Allow placed blocks for BREAK rewards", { defaultValue: false });

    const res = await form.show(player);
    if (res.canceled) return openAdminJobsMenu(player);

    const id = String(res.formValues?.[0] ?? "")
        .trim()
        .toLowerCase();
    const name = String(res.formValues?.[1] ?? "").trim();
    const desc = String(res.formValues?.[2] ?? "").trim();
    const icon = getJobIconByPresetIndex(res.formValues?.[3]);
    const allowPlacedBreak = !!res.formValues?.[4];

    if (!id || !/^[a-z0-9_\-]+$/.test(id)) {
        tell(player, "§cInvalid ID. Use letters/numbers/_/- only.");

        return openAdminJobsMenu(player);
    }

    if (!name) {
        tell(player, "§cName cannot be empty.");

        return openAdminJobsMenu(player);
    }

    const jobs = loadJobs();

    if (jobs.jobs.some((j) => j.id === id)) {
        tell(player, "§cA job with that ID already exists.");

        return openAdminJobsMenu(player);
    }

    jobs.jobs.push({
        id,
        name,
        description: desc,
        icon,
        enabled: true,
        allowPlacedBreak,
        rules: { break: {}, place: {}, kill: {} },
    });

    if (!saveJobsOrWarn(player, jobs)) {
        jobs.jobs.pop();

        return openAdminJobsMenu(player);
    }

    tell(player, "§aJob added.");

    return openAdminJobsMenu(player);
}

async function openPickJobToEdit(player) {
    const jobs = loadJobs();

    const form = new ActionFormData().title("Edit Job").body("§8Pick a job:").button("§8§lBack", "textures/ui/arrow_left");

    for (const j of jobs.jobs) {
        form.button(`§f§l${j.name} §r§8(${j.id})`, getJobIcon(j));
    }

    const res = await form.show(player);
    if (res.canceled || res.selection === 0) return openAdminJobsMenu(player);

    const job = jobs.jobs[res.selection - 1];
    if (!job) return openAdminJobsMenu(player);

    return openEditJob(player, job.id);
}

async function openEditJob(player, jobId) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    const form = new ActionFormData()
        .title(`Edit: ${job.name}`)
        .body(
            `§8${job.description || ""}\n` +
                `§8Enabled: ${job.enabled ? "§2Yes" : "§cNo"}\n` +
                `§8Icon: §f${getJobIcon(job)}\n` +
                `§8Allow placed BREAK: ${job.allowPlacedBreak ? "§2Yes" : "§cNo"}`,
        )
        .button("§e§lEdit Info / Icon / PlacedBreak", "textures/ui/editIcon")
        .button(job.enabled ? "§c§lDisable Job" : "§2§lEnable Job", job.enabled ? "textures/ui/cancel" : "textures/ui/confirm")
        .button("§b§lEdit Break Rewards", "textures/items/iron_pickaxe")
        .button("§b§lEdit Place Rewards", "textures/blocks/grass_side_carried")
        .button("§b§lEdit Kill Rewards", "textures/items/iron_sword")
        .button("§c§lDelete Job", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openPickJobToEdit(player);

    if (res.selection === 0) return openEditJobMeta(player, jobId);

    if (res.selection === 1) {
        job.enabled = !job.enabled;
        saveJobsOrWarn(player, jobs);

        return openEditJob(player, jobId);
    }

    if (res.selection === 2) return openEditRewards(player, jobId, "break", "Block ID");
    if (res.selection === 3) return openEditRewards(player, jobId, "place", "Block ID");
    if (res.selection === 4) return openEditRewards(player, jobId, "kill", "Entity ID");
    if (res.selection === 5) return openDeleteJobConfirm(player, jobId);

    return openPickJobToEdit(player);
}

function cleanRewardName(id) {
    return String(id ?? "")
        .replace(/^minecraft:/, "")
        .split("_")
        .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
        .join(" ");
}

function formatRewardList(title, rewards) {
    const entries = Object.entries(rewards ?? {})
        .filter(([, cents]) => Number.isInteger(cents) && cents > 0)
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    if (entries.length === 0) return "";

    const lines = [`§d${title}:`];

    for (const [id, cents] of entries) {
        lines.push(`§8- §f${cleanRewardName(id)} §8= §2${formatCents(cents)}`);
    }

    return lines.join("\n");
}

function buildJobDetailsBody(job, currentJobId) {
    const sections = [];

    sections.push(`§8Job: §f${job.name}`);
    if (job.description) sections.push(`§8${job.description}`);
    sections.push("");

    if (job.id === currentJobId) {
        sections.push("§2You already have this job.");
        sections.push("");
    }

    const breakRewards = formatRewardList("Break rewards", job.rules?.break);
    const placeRewards = formatRewardList("Place rewards", job.rules?.place);
    const killRewards = formatRewardList("Kill rewards", job.rules?.kill);

    if (breakRewards) sections.push(breakRewards, "");
    if (placeRewards) sections.push(placeRewards, "");
    if (killRewards) sections.push(killRewards, "");

    if (!breakRewards && !placeRewards && !killRewards) {
        sections.push("§cThis job has no rewards configured yet.");
    }

    return sections.join("\n").trim();
}

async function openEditJobMeta(player, jobId) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    const form = new ModalFormData()
        .title("Edit Job Info")
        .textField("Name", "ex: Miner", { defaultValue: job.name })
        .textField("Description", "shown in UI", { defaultValue: job.description || "" })
        .dropdown("Job icon", getJobIconOptions(), { defaultValueIndex: getJobIconPresetIndex(job.icon) })
        .toggle("Allow placed blocks for BREAK rewards", { defaultValue: !!job.allowPlacedBreak });

    const res = await form.show(player);
    if (res.canceled) return openEditJob(player, jobId);

    const name = String(res.formValues?.[0] ?? "").trim();
    const desc = String(res.formValues?.[1] ?? "").trim();
    const icon = getJobIconByPresetIndex(res.formValues?.[2]);
    const allowPlacedBreak = !!res.formValues?.[3];

    if (!name) {
        tell(player, "§cName cannot be empty.");

        return openEditJob(player, jobId);
    }

    job.name = name;
    job.description = desc;
    job.icon = icon;
    job.allowPlacedBreak = allowPlacedBreak;

    saveJobsOrWarn(player, jobs);

    return openEditJob(player, jobId);
}

async function openEditRewards(player, jobId, type, idLabel) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    if (!job.rules[type]) job.rules[type] = {};

    const entries = Object.entries(job.rules[type]);

    const form = new ActionFormData()
        .title(`${job.name} - ${type} rewards`)
        .body("§8Pick a rule to edit/remove, or add a new one.")
        .button("§2§lAdd Rule", "textures/ui/color_plus")
        .button("§8§lBack", "textures/ui/arrow_left");

    for (const [id, c] of entries) {
        form.button(`§f§l${shortId(id)}\n§r§e${formatCents(c)}`, getRewardRuleIcon(type, id));
    }

    const res = await form.show(player);
    if (res.canceled) return openEditJob(player, jobId);

    if (res.selection === 0) return openAddRule(player, jobId, type, idLabel);
    if (res.selection === 1) return openEditJob(player, jobId);

    const idx = res.selection - 2;
    const picked = entries[idx];
    if (!picked) return openEditRewards(player, jobId, type, idLabel);

    return openRuleActions(player, jobId, type, idLabel, picked[0]);
}

async function openAddRule(player, jobId, type, idLabel) {
    const form = new ModalFormData()
        .title(`Add ${type} rule`)
        .textField(idLabel, "ex: minecraft:oak_log", { defaultValue: "" })
        .textField("Reward (each)", "ex: 5 or 0.25", { defaultValue: "1" });

    const res = await form.show(player);
    if (res.canceled) return openEditRewards(player, jobId, type, idLabel);

    const id = String(res.formValues?.[0] ?? "").trim();
    const parsed = parseJobMoney(res.formValues?.[1]);
    if (!id || !parsed.ok || parsed.cents <= 0) {
        tell(player, "§cInvalid id or reward.");

        return openEditRewards(player, jobId, type, idLabel);
    }

    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    if (!job.rules[type]) job.rules[type] = {};
    job.rules[type][id] = parsed.cents;

    saveJobsOrWarn(player, jobs);
    tell(player, "§aRule added.");

    return openEditRewards(player, jobId, type, idLabel);
}

async function openRuleActions(player, jobId, type, idLabel, id) {
    const form = new ActionFormData()
        .title(`${type} rule`)
        .body(`§8${id}`)
        .button("§e§lEdit Reward", "textures/ui/editIcon")
        .button("§c§lRemove Rule", "textures/ui/trash")
        .button("§8§lBack", "textures/ui/arrow_left");

    const res = await form.show(player);
    if (res.canceled) return openEditRewards(player, jobId, type, idLabel);

    if (res.selection === 0) return openEditRuleReward(player, jobId, type, idLabel, id);
    if (res.selection === 1) return openRemoveRuleConfirm(player, jobId, type, idLabel, id);

    return openEditRewards(player, jobId, type, idLabel);
}

async function openEditRuleReward(player, jobId, type, idLabel, id) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);
    if (!job) return openAdminJobsMenu(player);

    const current = job.rules?.[type]?.[id] ?? 0;

    const form = new ModalFormData()
        .title("Edit Reward")
        .textField("Reward (each)", "ex: 5 or 0.25", { defaultValue: String(current / 100) });

    const res = await form.show(player);
    if (res.canceled) return openEditRewards(player, jobId, type, idLabel);

    const parsed = parseJobMoney(res.formValues?.[0]);
    if (!parsed.ok || parsed.cents <= 0) {
        tell(player, "§cInvalid reward.");

        return openEditRewards(player, jobId, type, idLabel);
    }

    job.rules[type][id] = parsed.cents;
    saveJobsOrWarn(player, jobs);
    tell(player, "§aReward updated.");

    return openEditRewards(player, jobId, type, idLabel);
}

async function openRemoveRuleConfirm(player, jobId, type, idLabel, id) {
    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§c§lRemove Rule?")
        .body(`§cRemove reward rule for:\n§f${id}\n\n` + "§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lRemove Rule", "textures/ui/trash");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openEditRewards(player, jobId, type, idLabel);
    }

    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);

    if (!job) {
        return openAdminJobsMenu(player);
    }

    if (job.rules?.[type]) {
        delete job.rules[type][id];
    }

    saveJobsOrWarn(player, jobs);
    tell(player, "§aRule removed.");

    return openEditRewards(player, jobId, type, idLabel);
}

async function openDeleteJobConfirm(player, jobId) {
    const jobs = loadJobs();
    const job = jobs.jobs.find((j) => j.id === jobId);

    if (!job) {
        return openAdminJobsMenu(player);
    }

    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§c§lDelete Job?")
        .body(`§cDelete job §f${job.name}§c?\n\n` + "§8This cannot be undone.")
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lDelete Job", "textures/ui/trash");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openEditJob(player, jobId);
    }

    jobs.jobs = jobs.jobs.filter((j) => j.id !== jobId);

    saveJobsOrWarn(player, jobs);
    tell(player, "§aJob deleted.");

    return openAdminJobsMenu(player);
}

async function openResetJobsConfirm(player) {
    const form = new ActionFormData()
        .use8CrafterLayout("long")
        .title("§c§lRestore Default Jobs?")
        .body(
            "§cThis will restore the default jobs.\n" +
                "§8Your current custom jobs and rewards will be overwritten.\n\n" +
                "§8This cannot be undone.",
        )
        .button("§c§lCancel", "textures/ui/cancel")
        .button("§c§lRestore Defaults", "textures/ui/refresh_light");

    const res = await form.show(player);

    if (res.canceled || res.selection === 0) {
        return openAdminJobsMenu(player);
    }

    saveJobsOrWarn(player, deepClone(DEFAULT_JOBS));
    tell(player, "§aJobs reset to defaults.");

    return openAdminJobsMenu(player);
}

function parseJobMoney(text) {
    const s = String(text ?? "").trim();
    const num = Number(s.replace(",", "."));
    if (!Number.isFinite(num)) return { ok: false, error: "Invalid number." };

    return parseFloatToCents(num, false);
}
