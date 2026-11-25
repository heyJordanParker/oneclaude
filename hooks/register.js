// node_modules/@cmodjs/core/hotkeys.js
var hotkeyName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
var comboShape = /^(?:(?:ctrl|alt|shift|meta)\+){1,2}(?:[a-z0-9]|f(?:[1-9]|1[0-2])|tab|enter|escape|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|[`\-=[\]\\;',./])$/;
var order = ["ctrl", "alt", "shift", "meta"];
function isCombo(value) {
  if (typeof value !== "string" || !comboShape.test(value))
    return false;
  const modifiers = value.split("+").slice(0, -1);
  return modifiers.every((each, index) => index === 0 || order.indexOf(each) > order.indexOf(modifiers[index - 1]));
}
function checkHotkeys(name, hotkeys) {
  const combos = new Map;
  for (const [key, declared] of Object.entries(hotkeys)) {
    const at = `${name}: hotkeys.${key}`;
    if (!hotkeyName.test(key))
      throw new Error(`${at} is not a hotkey name. Use letters, digits, and _, starting with a letter.`);
    if (declared.title.trim() === "")
      throw new Error(`${at} needs a title, the label Settings shows beside its combo.`);
    if (declared.default === undefined)
      continue;
    if (!isCombo(declared.default))
      throw new Error(`${at} defaults to "${String(declared.default)}", which is not a combo. Give one or two of ctrl, alt, shift, meta in that order, then a key, such as "ctrl+q" or "ctrl+shift+k".`);
    const taken = combos.get(declared.default);
    if (taken !== undefined)
      throw new Error(`${at} defaults to ${declared.default}, which hotkeys.${taken} has too. Give each hotkey its own combo.`);
    combos.set(declared.default, key);
  }
  return hotkeys;
}

// node_modules/@cmodjs/core/utils/text.js
function listed(items) {
  if (items.length <= 1)
    return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
function firstLine(text) {
  return text.split(`
`).find((line) => line.trim() !== "")?.trim() ?? "";
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function formatExit(code, reason) {
  const exit = code === null ? "was stopped by a signal" : `exited ${code}`;
  const clause = reason.trim().replace(/[.!?]+$/, "");
  return clause ? `${exit}: ${clause}` : exit;
}

// node_modules/@cmodjs/core/records.js
var listPermissions = ["network", "run", "files", "config"];
var flagPermissions = ["conversation", "prompt", "model", "tasks", "tools", "approve"];
var permissionNames = [...listPermissions, ...flagPermissions];
var hostName = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
var programName = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
var releaseVersion = /^\d+\.\d+\.\d+$/;
var settingPath = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9_@-]+)*$/;
var listItemHint = {
  network: 'a host alone, such as "api.github.com", or a socket path, such as "/var/run/docker.sock"',
  run: `a program's command, such as "gh"`,
  files: 'a path that starts with ~/ or /, such as "~/.zshrc"',
  config: `a Claude Code setting's name, or a key path inside one, such as "cleanupPeriodDays" or "env.ANTHROPIC_BASE_URL"`
};
var pluginName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function xdgFolder(env, variable, underHome) {
  const base = env[variable];
  const home = env["HOME"];
  if (base)
    return `${base}/cmod`;
  if (!home)
    throw new Error(`Neither ${variable} nor HOME is set, so cmod has no folder there. Set HOME.`);
  return `${home}/${underHome}/cmod`;
}
function storeFolder(env) {
  return xdgFolder(env, "XDG_DATA_HOME", ".local/share");
}
function recordPath(store, name) {
  return `${store}/records/${checkedName(name)}.json`;
}
function programPath(store, program, version) {
  return `${store}/bin/${checkedName(program)}/${version}/${program}`;
}
function linkedProgramPath(store, program, version) {
  return `${programPath(store, program, version)}.linked`;
}
async function programModifiedMs(modifiedMs, store, record) {
  if (record.program === null)
    return;
  const times = await Promise.all([programPath(store, record.program, record.version), linkedProgramPath(store, record.program, record.version)].map(modifiedMs));
  const found = times.filter((time) => time !== undefined);
  return found.length === 0 ? undefined : Math.max(...found);
}
function isProgramNewer(record, programModifiedMs) {
  return record.program !== null && (programModifiedMs === undefined || programModifiedMs > Date.parse(record.installedAt));
}
async function readCmodVersion(files, store) {
  if (!await files.exists(`${store}/programs/cmod`))
    return;
  const newestFirst = (await files.list(`${store}/bin/cmod`)).filter((name) => releaseVersion.test(name)).toSorted((one, other) => isAtLeast(one, other) ? -1 : 1);
  for (const version of newestFirst)
    if (await files.exists(programPath(store, "cmod", version)) || await files.exists(linkedProgramPath(store, "cmod", version)))
      return version;
  return;
}
function dataFolder(store, name) {
  return `${store}/data/${checkedName(name)}`;
}
function cacheFolder(env, name) {
  return `${xdgFolder(env, "XDG_CACHE_HOME", ".cache")}/${checkedName(name)}`;
}
function configFolder(env, name) {
  const configRoot = env["CLAUDE_CONFIG_DIR"];
  const home = env["HOME"];
  if (configRoot)
    return `${configRoot}/cmods/${checkedName(name)}`;
  if (!home)
    throw new Error(`Neither CLAUDE_CONFIG_DIR nor HOME is set, so ${name} has no config folder. Set HOME.`);
  return `${home}/.claude/cmods/${checkedName(name)}`;
}
function configFolders(env, name, root) {
  return [
    { tier: "system", folder: configFolder(env, name) },
    { tier: "project", folder: projectConfigFolder(root, name) }
  ];
}
function projectConfigFolder(root, name) {
  return `${root}/.claude/cmods/${checkedName(name)}`;
}
function checkedName(name) {
  if (!pluginName.test(name) || name.includes("..")) {
    throw new Error(`"${name}" is not a plugin name: use letters, digits, ".", "_", and "-", starting with a letter or digit.`);
  }
  return name;
}
async function readRecord(read, store, name) {
  const path = recordPath(store, name);
  const text = await read(path);
  if (text === undefined)
    return;
  return parseRecord(text, path);
}
function parseRecord(text, path) {
  const fix = `Delete ${path} and run cmod setup on the plugin again.`;
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON (${messageOf(error)}). ${fix}`);
  }
  if (!isObject(value))
    throw new Error(`${path} is not a cmod install record. ${fix}`);
  for (const key of ["name", "version", "root", "installedAt", "scriptsSha256"]) {
    if (typeof value[key] !== "string")
      throw new Error(`${path} has no "${key}" text. ${fix}`);
  }
  const uninstall = value["uninstall"];
  if (uninstall !== null && typeof uninstall !== "string")
    throw new Error(`${path} has an "uninstall" that is neither a path nor null. ${fix}`);
  const program = value["program"];
  if (program !== null && typeof program !== "string")
    throw new Error(`${path} has a "program" that is neither a command name nor null. ${fix}`);
  const keys = value["keys"] ?? {};
  if (!isObject(keys) || Object.values(keys).some((command) => typeof command !== "string"))
    throw new Error(`${path} has "keys" that are not key bindings. ${fix}`);
  const permissions = value["permissions"] ?? null;
  if (permissions !== null && !isTextList(permissions))
    throw new Error(`${path} has "permissions" that are not a list of permissions. ${fix}`);
  const grantedOnUpdate = value["grantedOnUpdate"] ?? [];
  if (!isTextList(grantedOnUpdate))
    throw new Error(`${path} has a "grantedOnUpdate" that is not a list of permissions. ${fix}`);
  const installedBy = value["installedBy"] ?? null;
  if (installedBy !== null && !(isObject(installedBy) && (installedBy["session"] === null || typeof installedBy["session"] === "string") && typeof installedBy["pid"] === "number"))
    throw new Error(`${path} has an "installedBy" that names no session and process. ${fix}`);
  return {
    name: value["name"],
    version: value["version"],
    root: value["root"],
    installedAt: value["installedAt"],
    scriptsSha256: value["scriptsSha256"],
    uninstall,
    program,
    keys,
    permissions,
    grantedOnUpdate,
    installedBy
  };
}
function readSteps(pkg) {
  if (pkg === undefined)
    return;
  if (!isObject(pkg))
    throw new Error("package.json is not a JSON object.");
  const steps = pkg["cmod"];
  if (steps === undefined)
    return;
  if (!isObject(steps))
    throw new Error('package.json has a "cmod" key that is not an object. Write "cmod": { "install": "./setup/install.sh", "uninstall": "./setup/uninstall.sh" }.');
  const program = steps["program"];
  if (program !== undefined && (typeof program !== "string" || !pluginName.test(program)))
    throw new Error(`package.json "cmod.program" must be the program's command, such as "hello".`);
  const approve = steps["approve"];
  if (approve !== undefined && approve !== true)
    throw new Error(`package.json "cmod.approve" is ${JSON.stringify(approve)}. Write "approve": true, or leave it out.`);
  const permissions = readPermissions(steps);
  return {
    ...readCommand(steps, "install"),
    ...readCommand(steps, "uninstall"),
    ...program === undefined ? {} : { program },
    ...readHotkeys(steps["hotkeys"]),
    ...approve === true || permissions.includes("approve") ? { approve: true } : {},
    ...permissions.length === 0 ? {} : { permissions }
  };
}
function readPermissions(steps) {
  const declared = steps["permissions"];
  if (declared === undefined)
    return [];
  const at = 'package.json "cmod.permissions"';
  if (!isObject(declared))
    throw new Error(`${at} must be an object, such as { "network": ["api.github.com"], "prompt": true }.`);
  const items = [];
  for (const [name, value] of Object.entries(declared)) {
    if (!permissionNames.includes(name))
      throw new Error(`${at} names "${name}", which is not a permission. Use ${listed(permissionNames.map((each) => `"${each}"`))}.`);
    if (flagPermissions.includes(name)) {
      if (value !== true)
        throw new Error(`${at} sets "${name}" to ${JSON.stringify(value)}. Write "${name}": true, or leave it out.`);
      items.push(name);
      continue;
    }
    if (name === "run" && value === "*") {
      items.push("run:*");
      continue;
    }
    const example = { network: '["api.github.com"]', run: '["gh"], or "*" for any program', files: '["~/.zshrc"]', config: '["cleanupPeriodDays"]' }[name];
    if (!Array.isArray(value) || value.length === 0 || !value.every((each) => typeof each === "string"))
      throw new Error(`${at} sets "${name}" to ${JSON.stringify(value)}. Write a list, such as "${name}": ${example}.`);
    for (const each of value) {
      const isPath = /^(~\/|\/)/.test(each) && !each.split("/").includes("..");
      const isValid = { network: hostName.test(each) || isPath, run: programName.test(each), files: isPath, config: settingPath.test(each) }[name];
      if (isValid !== true)
        throw new Error(`${at} lists "${each}" under "${name}". Write ${listItemHint[name]}.`);
      items.push(`${name}:${each}`);
    }
  }
  return items;
}
var installFix = "Install it in Plugins.";
var secretFix = "Set it in /config, where Claude Code keeps it in your keychain.";
var pendingStepsMethod = "cmod:pendingSteps";
var finishStepsMethod = "cmod:finishSteps";
var interfaceName = /^[a-z0-9][\w.-]*\/[A-Z]\w*$/;
function serviceFolder(store, mod) {
  return `${store}/services/${checkedName(mod)}`;
}
function preferencesPath(store) {
  return `${store}/preferences.json`;
}
var preferenceKeys = ["showsInstalledModErrors", "servesWebUi", "servesTailnet", "roundsBarEnds"];
function parsePreferences(value, path) {
  if (value !== undefined && (!isObject(value) || preferenceKeys.some((key) => value[key] !== undefined && typeof value[key] !== "boolean")))
    throw new Error(`${path} is not a map of cmod's preferences to true or false. Delete it, and cmod uses its defaults.`);
  const saved = isObject(value) ? value : {};
  return { showsInstalledModErrors: saved["showsInstalledModErrors"] === true, servesWebUi: saved["servesWebUi"] === true, servesTailnet: saved["servesTailnet"] !== false, roundsBarEnds: saved["roundsBarEnds"] === true };
}
var nerdFontTerminals = ["herdr", "ghostty", "WezTerm"];
function isNerdFontTerminal({ program, ghostty, wezterm }) {
  return nerdFontTerminals.includes(program ?? "") || (ghostty ?? "") !== "" || (wezterm ?? "") !== "";
}
function browserCommand(env, href) {
  if (env.browser === "true")
    return;
  if (env.browser)
    return [env.browser, href];
  if (env.sshConnection)
    return;
  if (env.os === "darwin")
    return ["open", href];
  return env.display || env.waylandDisplay ? ["xdg-open", href] : undefined;
}
function readHotkeys(hotkeys) {
  if (hotkeys === undefined)
    return {};
  const fix = "cmod check writes it from the hotkeys defineMod declares, so run cmod check.";
  if (!isObject(hotkeys) || !Object.values(hotkeys).every((each) => isObject(each) && typeof each["title"] === "string" && (each["default"] === undefined || typeof each["default"] === "string")))
    throw new Error(`package.json "cmod.hotkeys" is not a map of hotkeys to their title and optional default combo. ${fix}`);
  return { hotkeys: checkHotkeys('package.json "cmod"', hotkeys) };
}
var coreVersion = "8.9.0";
var oldestCmodVersion = "8.0.0";
function hotkeyCommand(mod, hotkey) {
  return `${mod}--${hotkey}`;
}
function boundCombos(keybindings) {
  const blocks = isObject(keybindings) && Array.isArray(keybindings["bindings"]) ? keybindings["bindings"] : [];
  const combos = new Map;
  for (const block of blocks) {
    if (!isObject(block) || block["context"] !== "Chat" || !isObject(block["bindings"]))
      continue;
    for (const [combo, action] of Object.entries(block["bindings"]))
      if (typeof action === "string" && action.startsWith("command:"))
        combos.set(action.slice("command:".length), combo);
  }
  return combos;
}
function readCommand(steps, key) {
  const command = steps[key];
  if (command === undefined)
    return {};
  if (typeof command !== "string" || command.trim() === "")
    throw new Error(`package.json "cmod.${key}" must be a command, such as "./setup/${key}.sh".`);
  if (/[\n\t]/.test(command))
    throw new Error(`package.json "cmod.${key}" holds a line break or a tab. Write one command, such as "./setup/${key}.sh".`);
  const atRoot = scriptPaths(command).find((path) => folderOf(path) === ".");
  if (atRoot !== undefined)
    throw new Error(`package.json "cmod.${key}" names ${atRoot}, a script at the plugin root. Move it into a folder, such as ./setup/${key}.sh: cmod runs the steps again whenever anything in a script's folder changes.`);
  return { [key]: command };
}
function scriptPaths(command) {
  const words = command.split(/[\s;&|()<>]+/).map((word) => word.replace(/^['"]|['"]$/g, "")).filter((word) => word.includes("/") && !word.startsWith("-") && !word.startsWith("/") && !word.startsWith("~") && !word.startsWith("$") && !word.includes("=") && !word.split("/").includes(".."));
  return [...new Set(words)];
}
function folderOf(path) {
  return path.slice(0, path.lastIndexOf("/"));
}
async function scriptsSha256(steps, files) {
  const folders = new Set;
  for (const key of ["install", "uninstall"]) {
    const command = steps[key];
    if (command === undefined)
      continue;
    const scriptFolders = [];
    for (const path of scriptPaths(command)) {
      if (await files.read(path) !== undefined)
        scriptFolders.push(folderOf(path));
    }
    if (scriptFolders.length === 0)
      throw new Error(`package.json "cmod.${key}" runs "${command}", which names no script file in the mod, so cmod cannot tell when what it runs changes. Put the commands in a script, such as ./setup/${key}.sh.`);
    for (const folder of scriptFolders)
      folders.add(folder);
  }
  let text = [
    steps.install ?? "",
    steps.uninstall ?? "",
    steps.program ?? "",
    ...steps.hotkeys === undefined ? [] : [JSON.stringify(Object.entries(steps.hotkeys).sort())],
    ...steps.permissions === undefined ? [] : [JSON.stringify([...steps.permissions].sort())]
  ].join("\x00");
  for (const folder of [...folders].sort()) {
    for (const name of (await files.list(folder)).sort()) {
      const path = `${folder}/${name}`;
      const content = await files.read(path);
      if (content === undefined)
        throw new Error(`${path} links to a folder or to nothing, so cmod cannot tell when it changes. Point the link at a file, or delete it.`);
      text += `\x00${path}\x00${content}`;
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(new TextEncoder().encode(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function parseEvent(line) {
  const progress = /^progress (\d+) (\d+)(?: (.*))?$/.exec(line);
  if (progress !== null)
    return { type: "progress", done: Number(progress[1]), total: Number(progress[2]), label: progress[3] ?? "" };
  const consent = /^needs-consent (\S+)\t([^\t]*)\t([^\t]*)(?:\t(.*))?$/.exec(line);
  if (consent !== null) {
    const [hotkeys = "", ...permissions] = (consent[4] ?? "").split("\t");
    return { type: "needs-consent", sha256: consent[1], install: consent[2], uninstall: consent[3], hotkeys, permissions: permissions.filter((item) => item !== "") };
  }
  const done = /^done (\S+)(?: (\S+))?$/.exec(line);
  if (done !== null)
    return { type: "done", name: done[1], ...done[2] === undefined ? {} : { version: done[2] } };
  const missing = /^missing (\S+)$/.exec(line);
  if (missing !== null)
    return { type: "missing", name: missing[1] };
  const failed = /^failed (-?\d+)(?:\t(.*))?$/.exec(line);
  if (failed !== null)
    return { type: "failed", code: Number(failed[1]), message: failed[2] ?? "" };
  const retries = /^retries (changed|later)$/.exec(line);
  if (retries !== null)
    return { type: "retries", when: retries[1] };
  return { type: "log", text: line.replace(/^log /, "") };
}
function isAtLeast(version, minimum) {
  const parts = version.split(".").map(Number);
  const least = minimum.split(".").map(Number);
  for (let index = 0;index < Math.max(parts.length, least.length); index += 1) {
    const difference = (parts[index] ?? 0) - (least[index] ?? 0);
    if (difference !== 0)
      return difference > 0;
  }
  return true;
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTextList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// node_modules/@cmodjs/core/session/goal/task.js
var Task = "task";
var TaskStart = "taskStart";
var TaskEnd = "taskEnd";

// node_modules/@cmodjs/core/session/context/turn/message/note.js
var Note = "note";
var modNoteBlock = new RegExp(`<(${pluginName.source.slice(1, -1)})_mod>\\n([\\s\\S]*?)\\n</\\1_mod>`, "g");
function modNote(mod, text) {
  return `<${mod}_mod>
${text}
</${mod}_mod>`;
}

// node_modules/@cmodjs/core/session/context/turn/message/prompt.js
var Prompt = "prompt";

// node_modules/@cmodjs/core/session/context/turn/message/sender.js
var Person = "person";
var Mod = "mod";
var Schedule = "schedule";
var Channel = "channel";
var Sdk = "sdk";
var Engine = "engine";
var personOrigins = ["human", "composer", "bridge", "slack-ping"];
var sessionOrigins = ["peer", "peer-send-message", "coordinator", "projects-relay", "observer", "observer-activity"];
function senderOf(origin, isInTask) {
  const fields = isObject(origin) ? origin : {};
  const kind = typeof fields["kind"] === "string" ? fields["kind"] : undefined;
  if (kind === undefined)
    return { type: isInTask ? Task : Person };
  if (personOrigins.includes(kind))
    return { type: Person };
  if (sessionOrigins.includes(kind))
    return { type: "session" };
  if (kind === "auto-continuation")
    return { type: Engine };
  if (kind === "plugin" && typeof fields["name"] === "string")
    return { type: Mod, name: fields["name"], ...fields["asUser"] === true ? { as: Person } : {} };
  if (kind === "scheduled-trigger")
    return { type: Schedule };
  if (kind === "channel" && typeof fields["server"] === "string")
    return { type: Channel, name: fields["server"] };
  if (kind === "sdk")
    return { type: Sdk };
  if (kind === "task-notification")
    return { type: Task };
  return { type: isInTask ? Task : Person };
}

// node_modules/@cmodjs/core/session/context/turn/message/tool-call.js
var ToolCall = "toolCall";

// node_modules/@cmodjs/core/session/context/turn/message/tool-result.js
var ToolResult = "toolResult";

// node_modules/@cmodjs/core/session/context/turn/message/message.js
var Message = "message";

// node_modules/@cmodjs/core/session/context/context.js
var ContextStart = "contextStart";
var ContextEnd = "contextEnd";

// node_modules/@cmodjs/core/session/context/turn/turn.js
var TurnStart = "turnStart";
var TurnEnd = "turnEnd";

// node_modules/@cmodjs/core/session/goal/goal.js
var GoalChange = "goalChange";

// node_modules/@cmodjs/core/session/conversation.js
var forkAgentType = "fork";
var searchLimit = 50;

// node_modules/@cmodjs/core/session/session.js
var Session = "session";
var sessionEvents = {
  Message: "message",
  Prompt: "prompt",
  Note: "note",
  Reply: "reply",
  ToolCall: "toolCall",
  ToolResult: "toolResult",
  Skill: "skill",
  InstructionFile: "instructionFile",
  AttachedFile: "attachedFile",
  Notice: "notice",
  ContextStart: "contextStart",
  ContextEnd: "contextEnd",
  TurnStart: "turnStart",
  TurnEnd: "turnEnd",
  TaskStart: "taskStart",
  TaskEnd: "taskEnd",
  GoalChange: "goalChange",
  UsageChange: "usageChange"
};
var beforeEvents = ["Prompt", "Note", "Skill", "InstructionFile", "AttachedFile", "Reply", "ToolCall", "ToolResult", "Notice", "TaskStart", "TurnEnd", "ContextEnd"];
var processEvents = {
  ProjectSetup: { on: "Setup", before: "Setup" },
  SessionStart: { on: "SessionStart", before: "SessionStart" },
  SessionEnd: { on: "SessionEnd" },
  ModelChange: { on: "PostModelSwitch", before: "PreModelSwitch" },
  CwdChange: { on: "CwdChanged" },
  DirectoryAdd: { on: "DirectoryAdded" },
  WorktreeCreate: { on: "WorktreeCreate", before: "WorktreeCreate" },
  WorktreeRemove: { on: "WorktreeRemove" },
  Notification: { on: "Notification" },
  Elicitation: { on: "Elicitation", before: "Elicitation" },
  ElicitationResponse: { on: "ElicitationResult", before: "ElicitationResult" },
  PermissionCheck: { on: "tool.check", before: "tool.check" },
  PermissionRequest: { on: "PermissionRequest", before: "PermissionRequest" },
  PermissionDenial: { on: "PermissionDenied", before: "PermissionDenied" },
  ToolBatch: { on: "PostToolBatch", before: "PostToolBatch" },
  TodoCreate: { on: "TaskCreated", before: "TaskCreated" },
  TodoComplete: { on: "TaskCompleted", before: "TaskCompleted" },
  ReplyDisplay: { on: "MessageDisplay", before: "MessageDisplay" }
};

// node_modules/@cmodjs/core/utils/matcher.js
function matches(value, matcher) {
  if (matcher instanceof RegExp)
    return value !== undefined && value !== null && matcher.test(String(value));
  if (Array.isArray(matcher))
    return matcher.some((each) => matches(value, each));
  if (typeof matcher !== "object" || matcher === null)
    return value === matcher;
  if (Array.isArray(value))
    return value.some((each) => matches(each, matcher));
  if (typeof value !== "object" || value === null)
    return false;
  return Object.entries(matcher).every(([key, wanted]) => wanted === undefined || matches(value[key], wanted));
}
function sentMatcher(matcher) {
  if (matcher instanceof RegExp)
    return { regexp: matcher.source, flags: matcher.flags };
  if (Array.isArray(matcher))
    return matcher.map(sentMatcher);
  if (typeof matcher !== "object" || matcher === null)
    return matcher;
  return Object.fromEntries(Object.entries(matcher).filter(([, value]) => value !== undefined).map(([key, value]) => [key, sentMatcher(value)]));
}

// node_modules/@cmodjs/core/vendor.js
var Bt = Object.create;
var { getPrototypeOf: jt, defineProperty: Ve, getOwnPropertyNames: Gt } = Object;
var Ye = Object.prototype.hasOwnProperty;
function Ut(e) {
  return this[e];
}
var qt;
var Ft;
var Kt = (e, r, t) => {
  var n = e != null && typeof e === "object";
  if (n) {
    var o = r ? qt ??= new WeakMap : Ft ??= new WeakMap, u = o.get(e);
    if (u)
      return u;
  }
  t = e != null ? Bt(jt(e)) : {};
  let s = r || !e || !e.__esModule || !Ye.call(e, "default") ? Ve(t, "default", { value: e, enumerable: true }) : t;
  if (e && typeof e === "object" || typeof e === "function") {
    for (let i of Gt(e))
      if (!Ye.call(s, i))
        Ve(s, i, { get: Ut.bind(e, i), enumerable: true });
  }
  if (n)
    o.set(e, s);
  return s;
};
var me = (e, r) => () => (r || e((r = { exports: {} }).exports, r), r.exports);
var Se = me(function(Qn, dt) {
  var lt = { DOT_LITERAL: "\\.", PLUS_LITERAL: "\\+", QMARK_LITERAL: "\\?", SLASH_LITERAL: "\\/", ONE_CHAR: "(?=.)", QMARK: "[^/]", END_ANCHOR: "(?:\\/|$)", DOTS_SLASH: "\\.{1,2}(?:\\/|$)", NO_DOT: "(?!\\.)", NO_DOTS: "(?!(?:^|\\/)\\.{1,2}(?:\\/|$))", NO_DOT_SLASH: "(?!\\.{0,1}(?:\\/|$))", NO_DOTS_SLASH: "(?!\\.{1,2}(?:\\/|$))", QMARK_NO_DOT: "[^.\\/]", STAR: "[^/]*?", START_ANCHOR: "(?:^|\\/)", SEP: "/" }, wr = { ...lt, SLASH_LITERAL: "[\\\\/]", QMARK: "[^\\\\/]", STAR: "[^\\\\/]*?", DOTS_SLASH: "\\.{1,2}(?:[\\\\/]|$)", NO_DOT: "(?!\\.)", NO_DOTS: "(?!(?:^|[\\\\/])\\.{1,2}(?:[\\\\/]|$))", NO_DOT_SLASH: "(?!\\.{0,1}(?:[\\\\/]|$))", NO_DOTS_SLASH: "(?!\\.{1,2}(?:[\\\\/]|$))", QMARK_NO_DOT: "[^.\\\\/]", START_ANCHOR: "(?:^|[\\\\/])", END_ANCHOR: "(?:[\\\\/]|$)", SEP: "\\" }, Or = { __proto__: null, alnum: "a-zA-Z0-9", alpha: "a-zA-Z", ascii: "\\x00-\\x7F", blank: " \\t", cntrl: "\\x00-\\x1F\\x7F", digit: "0-9", graph: "\\x21-\\x7E", lower: "a-z", print: "\\x20-\\x7E ", punct: "\\-!\"#$%&'()\\*+,./:;<=>?@[\\]^_`{|}~", space: " \\t\\r\\n\\v\\f", upper: "A-Z", word: "A-Za-z0-9_", xdigit: "A-Fa-f0-9" };
  dt.exports = { DEFAULT_MAX_EXTGLOB_RECURSION: 0, MAX_LENGTH: 65536, POSIX_REGEX_SOURCE: Or, REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g, REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/, REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/, REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g, REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g, REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g, REPLACEMENTS: { __proto__: null, "***": "*", "**/**": "**", "**/**/**": "**" }, CHAR_0: 48, CHAR_9: 57, CHAR_UPPERCASE_A: 65, CHAR_LOWERCASE_A: 97, CHAR_UPPERCASE_Z: 90, CHAR_LOWERCASE_Z: 122, CHAR_LEFT_PARENTHESES: 40, CHAR_RIGHT_PARENTHESES: 41, CHAR_ASTERISK: 42, CHAR_AMPERSAND: 38, CHAR_AT: 64, CHAR_BACKWARD_SLASH: 92, CHAR_CARRIAGE_RETURN: 13, CHAR_CIRCUMFLEX_ACCENT: 94, CHAR_COLON: 58, CHAR_COMMA: 44, CHAR_DOT: 46, CHAR_DOUBLE_QUOTE: 34, CHAR_EQUAL: 61, CHAR_EXCLAMATION_MARK: 33, CHAR_FORM_FEED: 12, CHAR_FORWARD_SLASH: 47, CHAR_GRAVE_ACCENT: 96, CHAR_HASH: 35, CHAR_HYPHEN_MINUS: 45, CHAR_LEFT_ANGLE_BRACKET: 60, CHAR_LEFT_CURLY_BRACE: 123, CHAR_LEFT_SQUARE_BRACKET: 91, CHAR_LINE_FEED: 10, CHAR_NO_BREAK_SPACE: 160, CHAR_PERCENT: 37, CHAR_PLUS: 43, CHAR_QUESTION_MARK: 63, CHAR_RIGHT_ANGLE_BRACKET: 62, CHAR_RIGHT_CURLY_BRACE: 125, CHAR_RIGHT_SQUARE_BRACKET: 93, CHAR_SEMICOLON: 59, CHAR_SINGLE_QUOTE: 39, CHAR_SPACE: 32, CHAR_TAB: 9, CHAR_UNDERSCORE: 95, CHAR_VERTICAL_LINE: 124, CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279, extglobChars(e) {
    return { "!": { type: "negate", open: "(?:(?!(?:", close: `))${e.STAR})` }, "?": { type: "qmark", open: "(?:", close: ")?" }, "+": { type: "plus", open: "(?:", close: ")+" }, "*": { type: "star", open: "(?:", close: ")*" }, "@": { type: "at", open: "(?:", close: ")" } };
  }, globChars(e) {
    return e === true ? wr : lt;
  } };
});
var Te = me(function(kr) {
  var { REGEX_BACKSLASH: vr, REGEX_REMOVE_BACKSLASH: Tr, REGEX_SPECIAL_CHARS: Ir, REGEX_SPECIAL_CHARS_GLOBAL: Cr } = Se();
  kr.isObject = (e) => e !== null && typeof e === "object" && !Array.isArray(e);
  kr.hasRegexChars = (e) => Ir.test(e);
  kr.isRegexChar = (e) => e.length === 1 && kr.hasRegexChars(e);
  kr.escapeRegex = (e) => e.replace(Cr, "\\$1");
  kr.toPosixSlashes = (e) => e.replace(vr, "/");
  kr.isWindows = () => {
    if (typeof navigator < "u" && navigator.platform) {
      let e = navigator.platform.toLowerCase();
      return e === "win32" || e === "windows";
    }
    return false;
  };
  kr.removeBackslashes = (e) => e.replace(Tr, (r) => r === "\\" ? "" : r);
  kr.escapeLast = (e, r, t) => {
    let n = e.lastIndexOf(r, t);
    if (n === -1)
      return e;
    if (e[n - 1] === "\\")
      return kr.escapeLast(e, r, n - 1);
    return `${e.slice(0, n)}\\${e.slice(n)}`;
  };
  kr.removePrefix = (e, r = {}) => {
    let t = e;
    if (t.startsWith("./"))
      t = t.slice(2), r.prefix = "./";
    return t;
  };
  kr.wrapOutput = (e, r = {}, t = {}) => {
    let n = t.contains ? "" : "^", o = t.contains ? "" : "$", u = `${n}(?:${e})${o}`;
    if (r.negated === true)
      u = `(?:^(?!${u}).*$)`;
    return u;
  };
  kr.basename = (e, { windows: r } = {}) => {
    let t = e.split(r ? /[\\/]/ : "/"), n = t[t.length - 1];
    if (n === "")
      return t[t.length - 2];
    return n;
  };
});
var xt = me(function(Vn, _t) {
  var Ce = Te(), { CHAR_ASTERISK: Be, CHAR_AT: Gr, CHAR_BACKWARD_SLASH: xe, CHAR_COMMA: Ur, CHAR_DOT: je, CHAR_EXCLAMATION_MARK: Ge, CHAR_FORWARD_SLASH: gt, CHAR_LEFT_CURLY_BRACE: Ue, CHAR_LEFT_PARENTHESES: Ie, CHAR_LEFT_SQUARE_BRACKET: qr, CHAR_PLUS: Fr, CHAR_QUESTION_MARK: ht, CHAR_RIGHT_CURLY_BRACE: Kr, CHAR_RIGHT_PARENTHESES: $t, CHAR_RIGHT_SQUARE_BRACKET: Wr } = Se(), mt = (e) => e === gt || e === xe, yt = (e) => {
    if (e.isPrefix !== true)
      e.depth = e.isGlobstar ? 1 / 0 : 1;
  }, Xr = (e, r) => {
    let t = r || {}, n = e.length - 1, o = t.parts === true || t.tokens === true || t.scanToEnd === true, u = [], s = [], i = [], h2 = e, N = -1, _ = 0, w = 0, M = false, K = false, g = false, k = false, ee = false, q = false, L = false, H = false, ne = false, X = false, T = 0, V, A, I = { value: "", depth: 0, isGlob: false }, a = () => N >= n, Q = () => h2.charCodeAt(N + 1), C = () => (V = A, h2.charCodeAt(++N));
    while (N < n) {
      A = C();
      let P;
      if (A === xe) {
        if (L = I.backslashes = true, A = C(), A === Ue)
          q = true;
        continue;
      }
      if (q === true || A === Ue) {
        T++;
        while (a() !== true && (A = C())) {
          if (A === xe) {
            L = I.backslashes = true, C();
            continue;
          }
          if (A === Ue) {
            T++;
            continue;
          }
          if (q !== true && A === je && (A = C()) === je) {
            if (M = I.isBrace = true, g = I.isGlob = true, X = true, o === true)
              continue;
            break;
          }
          if (q !== true && A === Ur) {
            if (M = I.isBrace = true, g = I.isGlob = true, X = true, o === true)
              continue;
            break;
          }
          if (A === Kr) {
            if (T--, T === 0) {
              q = false, M = I.isBrace = true, X = true;
              break;
            }
          }
        }
        if (o === true)
          continue;
        break;
      }
      if (A === gt) {
        if (u.push(N), s.push(I), I = { value: "", depth: 0, isGlob: false }, X === true)
          continue;
        if (V === je && N === _ + 1) {
          _ += 2;
          continue;
        }
        w = N + 1;
        continue;
      }
      if (t.noext !== true) {
        if ((A === Fr || A === Gr || A === Be || A === ht || A === Ge) === true && Q() === Ie) {
          if (g = I.isGlob = true, k = I.isExtglob = true, X = true, A === Ge && N === _)
            ne = true;
          if (o === true) {
            let te = 0;
            while (a() !== true && (A = C())) {
              if (A === xe) {
                L = I.backslashes = true, C();
                continue;
              }
              if (A === Ie) {
                te++;
                continue;
              }
              if (A === $t && --te === 0) {
                X = true;
                break;
              }
            }
            continue;
          }
          break;
        }
      }
      if (A === Be) {
        if (V === Be)
          ee = I.isGlobstar = true;
        if (g = I.isGlob = true, X = true, o === true)
          continue;
        break;
      }
      if (A === ht) {
        if (g = I.isGlob = true, X = true, o === true)
          continue;
        break;
      }
      if (A === qr) {
        while (a() !== true && (P = C())) {
          if (P === xe) {
            L = I.backslashes = true, C();
            continue;
          }
          if (P === Wr) {
            K = I.isBracket = true, g = I.isGlob = true, X = true;
            break;
          }
        }
        if (o === true)
          continue;
        break;
      }
      if (t.nonegate !== true && A === Ge && N === _) {
        H = I.negated = true, _++;
        continue;
      }
      if (t.noparen !== true && A === Ie) {
        if (g = I.isGlob = true, o === true) {
          let J = 1;
          while (a() !== true && (A = C())) {
            if (A === xe) {
              L = I.backslashes = true, C();
              continue;
            }
            if (A === Ie) {
              J++;
              continue;
            }
            if (A === $t && --J === 0) {
              X = true;
              break;
            }
          }
          continue;
        }
        break;
      }
      if (g === true) {
        if (X = true, o === true)
          continue;
        break;
      }
    }
    if (t.noext === true)
      k = false, g = false;
    let B = h2, l = "", f = "";
    if (_ > 0)
      l = h2.slice(0, _), h2 = h2.slice(_), w -= _;
    if (B && g === true && w > 0)
      B = h2.slice(0, w), f = h2.slice(w);
    else if (g === true)
      B = "", f = h2;
    else
      B = h2;
    if (B && B !== "" && B !== "/" && B !== h2) {
      if (mt(B.charCodeAt(B.length - 1)))
        B = B.slice(0, -1);
    }
    if (t.unescape === true) {
      if (f)
        f = Ce.removeBackslashes(f);
      if (B && L === true)
        B = Ce.removeBackslashes(B);
    }
    let Y = { prefix: l, input: e, start: _, base: B, glob: f, isBrace: M, isBracket: K, isGlob: g, isExtglob: k, isGlobstar: ee, negated: H, negatedExtglob: ne };
    if (t.tokens === true) {
      if (Y.maxDepth = 0, !mt(A))
        s.push(I);
      Y.tokens = s;
    }
    if (t.parts === true || t.tokens === true) {
      let P;
      for (let W = 0;W < u.length; W++) {
        let ue = P !== undefined ? P + 1 : _, $e = u[W], fe = e.slice(ue, $e);
        if (t.tokens) {
          if (W === 0 && _ !== 0)
            s[W].isPrefix = true, s[W].value = l;
          else
            s[W].value = fe;
          yt(s[W]), Y.maxDepth += s[W].depth;
        }
        if ($e >= _)
          i.push(fe), P = $e;
      }
      let J = P !== undefined ? P + 1 : _, te = e.slice(J);
      if (i.push(te), t.tokens && P && P + 1 < e.length)
        s[s.length - 1].value = te, yt(s[s.length - 1]), Y.maxDepth += s[s.length - 1].depth;
      Y.slashes = u, Y.parts = i;
    }
    return Y;
  };
  _t.exports = Xr;
});
var St = me(function(Yn, Et) {
  var he = Se(), G = Te(), { MAX_LENGTH: ke, POSIX_REGEX_SOURCE: Qr, REGEX_NON_SPECIAL_CHARS: Zr, REGEX_SPECIAL_CHARS_BACKREF: Vr, REPLACEMENTS: At } = he, Yr = (e, r) => {
    if (typeof r.expandRange === "function")
      return r.expandRange(...e, r);
    e.sort();
    let t = `[${e.join("-")}]`;
    try {
      new RegExp(t);
    } catch (n) {
      return e.map((o) => G.escapeRegex(o)).join("..");
    }
    return t;
  }, Ae = (e, r) => `Missing ${e}: "${r}" - use "\\\\${r}" to match literal characters`, Rt = (e) => {
    let r = [], t = 0, n = 0, o = 0, u = "", s = false;
    for (let i of e) {
      if (s === true) {
        u += i, s = false;
        continue;
      }
      if (i === "\\") {
        u += i, s = true;
        continue;
      }
      if (i === '"') {
        o = o === 1 ? 0 : 1, u += i;
        continue;
      }
      if (o === 0) {
        if (i === "[")
          t++;
        else if (i === "]" && t > 0)
          t--;
        else if (t === 0) {
          if (i === "(")
            n++;
          else if (i === ")" && n > 0)
            n--;
          else if (i === "|" && n === 0) {
            r.push(u), u = "";
            continue;
          }
        }
      }
      u += i;
    }
    return r.push(u), r;
  }, Jr = (e) => {
    let r = false;
    for (let t of e) {
      if (r === true) {
        r = false;
        continue;
      }
      if (t === "\\") {
        r = true;
        continue;
      }
      if (/[?*+@!()[\]{}]/.test(t))
        return false;
    }
    return true;
  }, Fe = (e) => {
    let r = e.trim(), t = true;
    while (t === true)
      if (t = false, /^@\([^\\()[\]{}|]+\)$/.test(r))
        r = r.slice(2, -1), t = true;
    if (!Jr(r))
      return;
    return r.replace(/\\(.)/g, "$1");
  }, en = (e) => {
    let r = e.map(Fe).filter(Boolean);
    for (let t = 0;t < r.length; t++)
      for (let n = t + 1;n < r.length; n++) {
        let o = r[t], u = r[n], s = o[0];
        if (!s || o !== s.repeat(o.length) || u !== s.repeat(u.length))
          continue;
        if (o === u || o.startsWith(u) || u.startsWith(o))
          return true;
      }
    return false;
  }, qe = (e, r = true) => {
    if (e[0] !== "+" && e[0] !== "*" || e[1] !== "(")
      return;
    let t = 0, n = 0, o = 0, u = false;
    for (let s = 1;s < e.length; s++) {
      let i = e[s];
      if (u === true) {
        u = false;
        continue;
      }
      if (i === "\\") {
        u = true;
        continue;
      }
      if (i === '"') {
        o = o === 1 ? 0 : 1;
        continue;
      }
      if (o === 1)
        continue;
      if (i === "[") {
        t++;
        continue;
      }
      if (i === "]" && t > 0) {
        t--;
        continue;
      }
      if (t > 0)
        continue;
      if (i === "(") {
        n++;
        continue;
      }
      if (i === ")") {
        if (n--, n === 0) {
          if (r === true && s !== e.length - 1)
            return;
          return { type: e[0], body: e.slice(2, s), end: s };
        }
      }
    }
  }, tn = (e) => `${e.length === 1 ? G.escapeRegex(e[0]) : `[${e.map((t) => G.escapeRegex(t)).join("")}]`}*`, rn = (e) => {
    let r = 0, t = [];
    while (r < e.length) {
      let n = qe(e.slice(r), false);
      if (!n || n.type !== "*")
        return;
      let o = Rt(n.body).map((s) => s.trim());
      if (o.length !== 1)
        return;
      let u = Fe(o[0]);
      if (!u || u.length !== 1)
        return;
      t.push(u), r += n.end + 1;
    }
    if (t.length < 1)
      return;
    return t;
  }, nn = (e) => {
    let r = 0, t = e.trim(), n = qe(t);
    while (n)
      r++, t = n.body.trim(), n = qe(t);
    return r;
  }, sn = (e, r) => {
    if (r.maxExtglobRecursion === false)
      return { risky: false };
    let t = typeof r.maxExtglobRecursion === "number" ? r.maxExtglobRecursion : he.DEFAULT_MAX_EXTGLOB_RECURSION, n = Rt(e).map((i) => i.trim());
    if (n.length > 1) {
      if (n.some((i) => i === "") || n.some((i) => /^[*?]+$/.test(i)) || en(n))
        return { risky: true };
    }
    let o = [], u = false, s = true;
    for (let i of n) {
      let h2 = rn(i);
      if (h2) {
        u = true, o.push(...h2);
        continue;
      }
      let N = Fe(i);
      if (N && N.length === 1) {
        o.push(N);
        continue;
      }
      if (s = false, nn(i) > t)
        return { risky: true };
    }
    if (u)
      return s ? { risky: true, safeOutput: tn([...new Set(o)]) } : { risky: true };
    return { risky: false };
  }, Ke = (e, r) => {
    if (typeof e !== "string")
      throw TypeError("Expected a string");
    e = At[e] || e;
    let t = { ...r }, n = typeof t.maxLength === "number" ? Math.min(ke, t.maxLength) : ke, o = e.length;
    if (o > n)
      throw SyntaxError(`Input length: ${o}, exceeds maximum allowed length: ${n}`);
    let u = { type: "bos", value: "", output: t.prepend || "" }, s = [u], i = t.capture ? "" : "?:", h2 = he.globChars(t.windows), N = he.extglobChars(h2), { DOT_LITERAL: _, PLUS_LITERAL: w, SLASH_LITERAL: M, ONE_CHAR: K, DOTS_SLASH: g, NO_DOT: k, NO_DOT_SLASH: ee, NO_DOTS_SLASH: q, QMARK: L, QMARK_NO_DOT: H, STAR: ne, START_ANCHOR: X } = h2, T = (p) => `(${i}(?:(?!${X}${p.dot ? g : _}).)*?)`, V = t.dot ? "" : k, A = t.dot ? L : H, I = t.bash === true ? T(t) : ne;
    if (t.capture)
      I = `(${I})`;
    if (typeof t.noext === "boolean")
      t.noextglob = t.noext;
    let a = { input: e, index: -1, start: 0, dot: t.dot === true, consumed: "", output: "", prefix: "", backtrack: false, negated: false, brackets: 0, braces: 0, parens: 0, quotes: 0, globstar: false, tokens: s };
    e = G.removePrefix(e, a), o = e.length;
    let Q = [], C = [], B = [], l = u, f, Y = () => a.index === o - 1, P = a.peek = (p = 1) => e[a.index + p], J = a.advance = () => e[++a.index] || "", te = () => e.slice(a.index + 1), W = (p = "", j = 0) => {
      a.consumed += p, a.index += j;
    }, ue = (p) => {
      a.output += p.output != null ? p.output : p.value, W(p.value);
    }, $e = () => {
      let p = 1;
      while (P() === "!" && (P(2) !== "(" || P(3) === "?"))
        J(), a.start++, p++;
      if (p % 2 === 0)
        return false;
      return a.negated = true, a.start++, true;
    }, fe = (p) => {
      a[p]++, B.push(p);
    }, ae = (p) => {
      a[p]--, B.pop();
    }, R = (p) => {
      if (l.type === "globstar") {
        let j = a.braces > 0 && (p.type === "comma" || p.type === "brace"), d = p.extglob === true || Q.length && (p.type === "pipe" || p.type === "paren");
        if (p.type !== "slash" && p.type !== "paren" && !j && !d)
          a.output = a.output.slice(0, -l.output.length), l.type = "star", l.value = "*", l.output = I, a.output += l.output;
      }
      if (Q.length && p.type !== "paren")
        Q[Q.length - 1].inner += p.value;
      if (p.value || p.output)
        ue(p);
      if (l && l.type === "text" && p.type === "text") {
        l.output = (l.output || l.value) + p.value, l.value += p.value;
        return;
      }
      p.prev = l, s.push(p), l = p;
    }, de = (p, j) => {
      let d = { ...N[j], conditions: 1, inner: "" };
      d.prev = l, d.parens = a.parens, d.output = a.output, d.startIndex = a.index, d.tokensIndex = s.length;
      let O = (t.capture ? "(" : "") + d.open;
      fe("parens"), R({ type: p, value: j, output: a.output ? "" : K }), R({ type: "paren", extglob: true, value: J(), output: O }), Q.push(d);
    }, Re = (p) => {
      let j = e.slice(p.startIndex, a.index + 1), d = e.slice(p.startIndex + 2, a.index), O = sn(d, t);
      if ((p.type === "plus" || p.type === "star") && O.risky) {
        let z = O.safeOutput ? (p.output ? "" : K) + (t.capture ? `(${O.safeOutput})` : O.safeOutput) : undefined, re = s[p.tokensIndex];
        re.type = "text", re.value = j, re.output = z || G.escapeRegex(j);
        for (let ie = p.tokensIndex + 1;ie < s.length; ie++)
          s[ie].value = "", s[ie].output = "", delete s[ie].suffix;
        a.output = p.output + re.output, a.backtrack = true, R({ type: "paren", extglob: true, value: f, output: "" }), ae("parens");
        return;
      }
      let D = p.close + (t.capture ? ")" : ""), U;
      if (p.type === "negate") {
        let z = I;
        if (p.inner && p.inner.length > 1 && p.inner.includes("/"))
          z = T(t);
        if (z !== I || Y() || /^\)+$/.test(te()))
          D = p.close = `)$))${z}`;
        if (p.inner.includes("*") && (U = te()) && /^\.[^\\/.]+$/.test(U)) {
          let re = Ke(U, { ...r, fastpaths: false }).output;
          D = p.close = `)${re})${z})`;
        }
        if (p.prev.type === "bos")
          a.negatedExtglob = true;
      }
      R({ type: "paren", extglob: true, value: f, output: D }), ae("parens");
    };
    if (t.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(e)) {
      let p = false, j = e.replace(Vr, (d, O, D, U, z, re) => {
        if (U === "\\")
          return p = true, d;
        if (U === "?") {
          if (O)
            return O + U + (z ? L.repeat(z.length) : "");
          if (re === 0)
            return A + (z ? L.repeat(z.length) : "");
          return L.repeat(D.length);
        }
        if (U === ".")
          return _.repeat(D.length);
        if (U === "*") {
          if (O)
            return O + U + (z ? I : "");
          return I;
        }
        return O ? d : `\\${d}`;
      });
      if (p === true)
        if (t.unescape === true)
          j = j.replace(/\\/g, "");
        else
          j = j.replace(/\\+/g, (d) => d.length % 2 === 0 ? "\\\\" : d ? "\\" : "");
      if (j === e && t.contains === true)
        return a.output = e, a;
      return a.output = G.wrapOutput(j, a, r), a;
    }
    while (!Y()) {
      if (f = J(), f === "\x00")
        continue;
      if (f === "\\") {
        let d = P();
        if (d === "/" && t.bash !== true)
          continue;
        if (d === "." || d === ";")
          continue;
        if (!d) {
          f += "\\", R({ type: "text", value: f });
          continue;
        }
        let O = /^\\+/.exec(te()), D = 0;
        if (O && O[0].length > 2) {
          if (D = O[0].length, a.index += D, D % 2 !== 0)
            f += "\\";
        }
        if (t.unescape === true)
          f = J();
        else
          f += J();
        if (a.brackets === 0) {
          R({ type: "text", value: f });
          continue;
        }
      }
      if (a.brackets > 0 && (f !== "]" || l.value === "[" || l.value === "[^")) {
        if (t.posix !== false && f === ":") {
          let d = l.value.slice(1);
          if (d.includes("[")) {
            if (l.posix = true, d.includes(":")) {
              let O = l.value.lastIndexOf("["), D = l.value.slice(0, O), U = l.value.slice(O + 2), z = Qr[U];
              if (z) {
                if (l.value = D + z, a.backtrack = true, J(), !u.output && s.indexOf(l) === 1)
                  u.output = K;
                continue;
              }
            }
          }
        }
        if (f === "[" && P() !== ":" || f === "-" && P() === "]")
          f = `\\${f}`;
        if (f === "]" && (l.value === "[" || l.value === "[^"))
          f = `\\${f}`;
        if (t.posix === true && f === "!" && l.value === "[")
          f = "^";
        l.value += f, ue({ value: f });
        continue;
      }
      if (a.quotes === 1 && f !== '"') {
        f = G.escapeRegex(f), l.value += f, ue({ value: f });
        continue;
      }
      if (f === '"') {
        if (a.quotes = a.quotes === 1 ? 0 : 1, t.keepQuotes === true)
          R({ type: "text", value: f });
        continue;
      }
      if (f === "(") {
        fe("parens"), R({ type: "paren", value: f });
        continue;
      }
      if (f === ")") {
        if (a.parens === 0 && t.strictBrackets === true)
          throw SyntaxError(Ae("opening", "("));
        let d = Q[Q.length - 1];
        if (d && a.parens === d.parens + 1) {
          Re(Q.pop());
          continue;
        }
        R({ type: "paren", value: f, output: a.parens ? ")" : "\\)" }), ae("parens");
        continue;
      }
      if (f === "[") {
        if (t.nobracket === true || !te().includes("]")) {
          if (t.nobracket !== true && t.strictBrackets === true)
            throw SyntaxError(Ae("closing", "]"));
          f = `\\${f}`;
        } else
          fe("brackets");
        R({ type: "bracket", value: f });
        continue;
      }
      if (f === "]") {
        if (t.nobracket === true || l && l.type === "bracket" && l.value.length === 1) {
          R({ type: "text", value: f, output: `\\${f}` });
          continue;
        }
        if (a.brackets === 0) {
          if (t.strictBrackets === true)
            throw SyntaxError(Ae("opening", "["));
          R({ type: "text", value: f, output: `\\${f}` });
          continue;
        }
        ae("brackets");
        let d = l.value.slice(1);
        if (l.posix !== true && d[0] === "^" && !d.includes("/"))
          f = `/${f}`;
        if (l.value += f, ue({ value: f }), t.literalBrackets === false || G.hasRegexChars(d))
          continue;
        let O = G.escapeRegex(l.value);
        if (a.output = a.output.slice(0, -l.value.length), t.literalBrackets === true) {
          a.output += O, l.value = O;
          continue;
        }
        l.value = `(${i}${O}|${l.value})`, a.output += l.value;
        continue;
      }
      if (f === "{" && t.nobrace !== true) {
        fe("braces");
        let d = { type: "brace", value: f, output: "(", outputIndex: a.output.length, tokensIndex: a.tokens.length };
        C.push(d), R(d);
        continue;
      }
      if (f === "}") {
        let d = C[C.length - 1];
        if (t.nobrace === true || !d) {
          R({ type: "text", value: f, output: f });
          continue;
        }
        let O = ")";
        if (d.dots === true) {
          let D = s.slice(), U = [];
          for (let z = D.length - 1;z >= 0; z--) {
            if (s.pop(), D[z].type === "brace")
              break;
            if (D[z].type !== "dots")
              U.unshift(D[z].value);
          }
          O = Yr(U, t), a.backtrack = true;
        }
        if (d.comma !== true && d.dots !== true) {
          let D = a.output.slice(0, d.outputIndex), U = a.tokens.slice(d.tokensIndex);
          d.value = d.output = "\\{", f = O = "\\}", a.output = D;
          for (let z of U)
            a.output += z.output || z.value;
        }
        R({ type: "brace", value: f, output: O }), ae("braces"), C.pop();
        continue;
      }
      if (f === "|") {
        if (Q.length > 0)
          Q[Q.length - 1].conditions++;
        R({ type: "text", value: f });
        continue;
      }
      if (f === ",") {
        let d = f, O = C[C.length - 1];
        if (O && B[B.length - 1] === "braces")
          O.comma = true, d = "|";
        R({ type: "comma", value: f, output: d });
        continue;
      }
      if (f === "/") {
        if (l.type === "dot" && a.index === a.start + 1) {
          a.start = a.index + 1, a.consumed = "", a.output = "", s.pop(), l = u;
          continue;
        }
        R({ type: "slash", value: f, output: M });
        continue;
      }
      if (f === ".") {
        if (a.braces > 0 && l.type === "dot") {
          if (l.value === ".")
            l.output = _;
          let d = C[C.length - 1];
          l.type = "dots", l.output += f, l.value += f, d.dots = true;
          continue;
        }
        if (a.braces + a.parens === 0 && l.type !== "bos" && l.type !== "slash") {
          R({ type: "text", value: f, output: _ });
          continue;
        }
        R({ type: "dot", value: f, output: _ });
        continue;
      }
      if (f === "?") {
        if (!(l && l.value === "(") && t.noextglob !== true && P() === "(" && P(2) !== "?") {
          de("qmark", f);
          continue;
        }
        if (l && l.type === "paren") {
          let O = P(), D = f;
          if (l.value === "(" && !/[!=<:]/.test(O) || O === "<" && !/<([!=]|\w+>)/.test(te()))
            D = `\\${f}`;
          R({ type: "text", value: f, output: D });
          continue;
        }
        if (t.dot !== true && (l.type === "slash" || l.type === "bos")) {
          R({ type: "qmark", value: f, output: H });
          continue;
        }
        R({ type: "qmark", value: f, output: L });
        continue;
      }
      if (f === "!") {
        if (t.noextglob !== true && P() === "(") {
          if (P(2) !== "?" || !/[!=<:]/.test(P(3))) {
            de("negate", f);
            continue;
          }
        }
        if (t.nonegate !== true && a.index === 0) {
          $e();
          continue;
        }
      }
      if (f === "+") {
        if (t.noextglob !== true && P() === "(" && P(2) !== "?") {
          de("plus", f);
          continue;
        }
        if (l && l.value === "(" || t.regex === false) {
          R({ type: "plus", value: f, output: w });
          continue;
        }
        if (l && (l.type === "bracket" || l.type === "paren" || l.type === "brace") || a.parens > 0) {
          R({ type: "plus", value: f });
          continue;
        }
        R({ type: "plus", value: w });
        continue;
      }
      if (f === "@") {
        if (t.noextglob !== true && P() === "(" && P(2) !== "?") {
          R({ type: "at", extglob: true, value: f, output: "" });
          continue;
        }
        R({ type: "text", value: f });
        continue;
      }
      if (f !== "*") {
        if (f === "$" || f === "^")
          f = `\\${f}`;
        let d = Zr.exec(te());
        if (d)
          f += d[0], a.index += d[0].length;
        R({ type: "text", value: f });
        continue;
      }
      if (l && (l.type === "globstar" || l.star === true)) {
        l.type = "star", l.star = true, l.value += f, l.output = I, a.backtrack = true, a.globstar = true, W(f);
        continue;
      }
      let p = te();
      if (t.noextglob !== true && /^\([^?]/.test(p)) {
        de("star", f);
        continue;
      }
      if (l.type === "star") {
        if (t.noglobstar === true) {
          W(f);
          continue;
        }
        let d = l.prev, O = d.prev, D = d.type === "slash" || d.type === "bos", U = O && (O.type === "star" || O.type === "globstar");
        if (t.bash === true && (!D || p[0] && p[0] !== "/")) {
          R({ type: "star", value: f, output: "" });
          continue;
        }
        let z = a.braces > 0 && (d.type === "comma" || d.type === "brace"), re = Q.length && (d.type === "pipe" || d.type === "paren");
        if (!D && d.type !== "paren" && !z && !re) {
          R({ type: "star", value: f, output: "" });
          continue;
        }
        while (p.slice(0, 3) === "/**") {
          let pe = e[a.index + 4];
          if (pe && pe !== "/")
            break;
          p = p.slice(3), W("/**", 3);
        }
        let ie = Y() || a.parens > 0 && p === ")".repeat(a.parens) && !Q.some((pe) => pe.type === "negate");
        if (d.type === "bos" && Y()) {
          l.type = "globstar", l.value += f, l.output = T(t), a.output = l.output, a.globstar = true, W(f);
          continue;
        }
        if (d.type === "slash" && d.prev.type !== "bos" && !U && ie) {
          a.output = a.output.slice(0, -(d.output + l.output).length), d.output = `(?:${d.output}`, l.type = "globstar", l.output = T(t) + (t.strictSlashes ? ")" : "|$)"), l.value += f, a.globstar = true, a.output += d.output + l.output, W(f);
          continue;
        }
        if (d.type === "slash" && d.prev.type !== "bos" && p[0] === "/") {
          let pe = p[1] !== undefined ? "|$" : "";
          a.output = a.output.slice(0, -(d.output + l.output).length), d.output = `(?:${d.output}`, l.type = "globstar", l.output = `${T(t)}${M}|${M}${pe})`, l.value += f, a.output += d.output + l.output, a.globstar = true, W(f + J()), R({ type: "slash", value: "/", output: "" });
          continue;
        }
        if (d.type === "bos" && p[0] === "/") {
          l.type = "globstar", l.value += f, l.output = `(?:^|${M}|${T(t)}${M})`, a.output = l.output, a.globstar = true, W(f + J()), R({ type: "slash", value: "/", output: "" });
          continue;
        }
        a.output = a.output.slice(0, -l.output.length), l.type = "globstar", l.output = T(t), l.value += f, a.output += l.output, a.globstar = true, W(f);
        continue;
      }
      let j = { type: "star", value: f, output: I };
      if (t.bash === true) {
        if (j.output = ".*?", l.type === "bos" || l.type === "slash")
          j.output = V + j.output;
        R(j);
        continue;
      }
      if (l && (l.type === "bracket" || l.type === "paren") && t.regex === true) {
        j.output = f, R(j);
        continue;
      }
      if (a.index === a.start || l.type === "slash" || l.type === "dot") {
        if (l.type === "dot")
          a.output += ee, l.output += ee;
        else if (t.dot === true)
          a.output += q, l.output += q;
        else
          a.output += V, l.output += V;
        if (P() !== "*")
          a.output += K, l.output += K;
      }
      R(j);
    }
    while (a.brackets > 0) {
      if (t.strictBrackets === true)
        throw SyntaxError(Ae("closing", "]"));
      a.output = G.escapeLast(a.output, "["), ae("brackets");
    }
    while (a.parens > 0) {
      if (t.strictBrackets === true)
        throw SyntaxError(Ae("closing", ")"));
      a.output = G.escapeLast(a.output, "("), ae("parens");
    }
    while (a.braces > 0) {
      if (t.strictBrackets === true)
        throw SyntaxError(Ae("closing", "}"));
      a.output = G.escapeLast(a.output, "{"), ae("braces");
    }
    if (t.strictSlashes !== true && (l.type === "star" || l.type === "bracket"))
      R({ type: "maybe_slash", value: "", output: `${M}?` });
    if (a.backtrack === true) {
      a.output = "";
      for (let p of a.tokens)
        if (a.output += p.output != null ? p.output : p.value, p.suffix)
          a.output += p.suffix;
    }
    return a;
  };
  Ke.fastpaths = (e, r) => {
    let t = { ...r }, n = typeof t.maxLength === "number" ? Math.min(ke, t.maxLength) : ke, o = e.length;
    if (o > n)
      throw SyntaxError(`Input length: ${o}, exceeds maximum allowed length: ${n}`);
    e = At[e] || e;
    let { DOT_LITERAL: u, SLASH_LITERAL: s, ONE_CHAR: i, DOTS_SLASH: h2, NO_DOT: N, NO_DOTS: _, NO_DOTS_SLASH: w, STAR: M, START_ANCHOR: K } = he.globChars(t.windows), g = t.dot ? _ : N, k = t.dot ? w : N, ee = t.capture ? "" : "?:", q = { negated: false, prefix: "" }, L = t.bash === true ? ".*?" : M;
    if (t.capture)
      L = `(${L})`;
    let H = (V) => {
      if (V.noglobstar === true)
        return L;
      return `(${ee}(?:(?!${K}${V.dot ? h2 : u}).)*?)`;
    }, ne = (V) => {
      switch (V) {
        case "*":
          return `${g}${i}${L}`;
        case ".*":
          return `${u}${i}${L}`;
        case "*.*":
          return `${g}${L}${u}${i}${L}`;
        case "*/*":
          return `${g}${L}${s}${i}${k}${L}`;
        case "**":
          return g + H(t);
        case "**/*":
          return `(?:${g}${H(t)}${s})?${k}${i}${L}`;
        case "**/*.*":
          return `(?:${g}${H(t)}${s})?${k}${L}${u}${i}${L}`;
        case "**/.*":
          return `(?:${g}${H(t)}${s})?${u}${i}${L}`;
        default: {
          let A = /^(.*?)\.(\w+)$/.exec(V);
          if (!A)
            return;
          let I = ne(A[1]);
          if (!I)
            return;
          return I + u + A[2];
        }
      }
    }, X = G.removePrefix(e, q), T = ne(X);
    if (T && t.strictSlashes !== true)
      T += `${s}?`;
    return T;
  };
  Et.exports = Ke;
});
var wt = me(function(Jn, bt) {
  var on = xt(), He = St(), Ne = Te(), un = Se(), an = (e) => e && typeof e === "object" && !Array.isArray(e), Z = (e, r, t = false) => {
    if (Array.isArray(e)) {
      let _ = e.map((M) => Z(M, r, t));
      return (M) => {
        for (let K of _) {
          let g = K(M);
          if (g)
            return g;
        }
        return false;
      };
    }
    let n = an(e) && e.tokens && e.input;
    if (e === "" || typeof e !== "string" && !n)
      throw TypeError("Expected pattern to be a non-empty string");
    let o = r || {}, u = o.windows, s = n ? Z.compileRe(e, r) : Z.makeRe(e, r, false, true), i = s.state;
    delete s.state;
    let h2 = () => false;
    if (o.ignore) {
      let _ = { ...r, ignore: null, onMatch: null, onResult: null };
      h2 = Z(o.ignore, _, t);
    }
    let N = (_, w = false) => {
      let { isMatch: M, match: K, output: g } = Z.test(_, s, r, { glob: e, posix: u }), k = { glob: e, state: i, regex: s, posix: u, input: _, output: g, match: K, isMatch: M };
      if (typeof o.onResult === "function")
        o.onResult(k);
      if (M === false)
        return k.isMatch = false, w ? k : false;
      if (h2(_)) {
        if (typeof o.onIgnore === "function")
          o.onIgnore(k);
        return k.isMatch = false, w ? k : false;
      }
      if (typeof o.onMatch === "function")
        o.onMatch(k);
      return w ? k : true;
    };
    if (t)
      N.state = i;
    return N;
  };
  Z.test = (e, r, t, { glob: n, posix: o } = {}) => {
    if (typeof e !== "string")
      throw TypeError("Expected input to be a string");
    if (e === "")
      return { isMatch: false, output: "" };
    let u = t || {}, s = u.format || (o ? Ne.toPosixSlashes : null), i = e === n, h2 = i && s ? s(e) : e;
    if (i === false)
      h2 = s ? s(e) : e, i = h2 === n;
    if (i === false || u.capture === true)
      if (u.matchBase === true || u.basename === true)
        i = Z.matchBase(e, r, t, o);
      else
        i = r.exec(h2);
    return { isMatch: Boolean(i), match: i, output: h2 };
  };
  Z.matchBase = (e, r, t, n = t && t.windows) => (r instanceof RegExp ? r : Z.makeRe(r, t)).test(Ne.basename(e, { windows: n }));
  Z.isMatch = (e, r, t) => Z(r, t)(e);
  Z.parse = (e, r) => {
    if (Array.isArray(e))
      return e.map((t) => Z.parse(t, r));
    return He(e, { ...r, fastpaths: false });
  };
  Z.scan = (e, r) => on(e, r);
  Z.compileRe = (e, r, t = false, n = false) => {
    if (t === true)
      return e.output;
    let o = r || {}, u = o.contains ? "" : "^", s = o.contains ? "" : "$", i = `${u}(?:${e.output})${s}`;
    if (e && e.negated === true)
      i = `^(?!${i}).*$`;
    let h2 = Z.toRegex(i, r);
    if (n === true)
      h2.state = e;
    return h2;
  };
  Z.makeRe = (e, r = {}, t = false, n = false) => {
    if (!e || typeof e !== "string")
      throw TypeError("Expected a non-empty string");
    let o = { negated: false, fastpaths: true };
    if (r.fastpaths !== false && (e[0] === "." || e[0] === "*"))
      o.output = He.fastpaths(e, r);
    if (!o.output)
      o = He(e, r);
    return Z.compileRe(o, r, t, n);
  };
  Z.toRegex = (e, r) => {
    try {
      let t = r || {};
      return new RegExp(e, t.flags || (t.nocase ? "i" : ""));
    } catch (t) {
      if (r && r.debug === true)
        throw t;
      return /$^/;
    }
  };
  Z.constants = un;
  bt.exports = Z;
});
var vt = me(function(es, Ot) {
  var fn = ["||", "&&", ";;&", ";;", ";&", "|&", "<(", ">(", "<<<", "<<-", "<<", ">>", ">&", ">|", "&>>", "&>", "<&", "<>", "&", ";", "(", ")", "|", "<", ">"], We = /[\n\r\u2028\u2029]/, ln = /[\s#!"$&'():;<=>@\\^`|~]/g;
  Ot.exports = function(r) {
    var t = false;
    return r.map(function(n) {
      if (t && typeof n === "string" && We.test(n))
        throw TypeError("a token after a `comment` must not contain line terminators");
      if (n === "")
        return "''";
      if (n && typeof n === "object") {
        if ("op" in n && n.op === "glob") {
          if (typeof n.pattern !== "string")
            throw TypeError("glob token requires a string `pattern`");
          if (We.test(n.pattern))
            throw TypeError("glob `pattern` must not contain line terminators");
          if (n.pattern === "")
            return "''";
          return n.pattern.replace(ln, "\\$&");
        }
        if ("op" in n && typeof n.op === "string") {
          if (fn.indexOf(n.op) < 0)
            throw TypeError("invalid `op` value: " + JSON.stringify(n.op));
          return n.op.replace(/[\s\S]/g, "\\$&");
        }
        if ("comment" in n && typeof n.comment === "string") {
          if (We.test(n.comment))
            throw TypeError("`comment` must not contain line terminators");
          return t = true, "#" + n.comment;
        }
        throw TypeError("unrecognized object token shape");
      }
      if (/'/.test(n) && /!/.test(n))
        return "'" + n.replace(/'/g, `'"'"'`) + "'";
      if (/["\s\\]/.test(n) && !/'/.test(n))
        return "'" + n + "'";
      if (/["'\s]/.test(n))
        return '"' + n.replace(/(["\\$`])/g, "\\$1") + '"';
      return String(n).replace(/([A-Za-z]:)?([#!"$&'()*,:;<=>?@[\\\]^`{|}~])/g, "$1\\$2");
    }).join(" ");
  };
});
var Pt = me(function(ts, Lt) {
  var Ht = "(?:" + ["\\|\\|", "\\&(?:\\&|>>?)", ";;\\&?", "[;|]\\&", "\\<\\(", "\\<\\<\\<", "\\<\\<-", "\\<\\<(?!\\()", ">>", ">[&|(]", "<[&>]", "[&;()|<>]"].join("|") + ")", Tt = new RegExp("^" + Ht + "$"), It = "|&;()<> \\t", dn = "'([^']*?)'", Nt = "(?:\\\\[\\s\\S]|[^\\\\'])*?", Ct = "\\$'" + Nt + "'", Pe = new RegExp("\\$'" + Nt + "(?:(')|\\\\?$)", "g"), pn = "abeEfnrtv", cn = `\x07\b\x1B\x1B\f
\r	\v`, hn = /^#$/, Xe = "'", kt = '"', be = "$", ge = "", $n = 4294967296;
  for (Le = 0;Le < 4; Le++)
    ge += ($n * Math.random()).toString(16);
  var Le, mn = new RegExp("^" + ge);
  function yn(e, r) {
    var t = r.lastIndex, n = [], o;
    while (o = r.exec(e))
      if (n[n.length] = o, r.lastIndex === o.index)
        r.lastIndex += 1;
    return r.lastIndex = t, n;
  }
  function gn(e, r, t) {
    var n = typeof e === "function" ? e(t) : e[t];
    if (typeof n > "u" && t != "")
      n = "";
    else if (typeof n > "u")
      n = "$";
    if (typeof n === "object")
      return r + ge + JSON.stringify(n) + ge;
    return r + n;
  }
  var _n = /\\([0-7]{1,3}|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}|c(?:\\\\|[\s\S])|[abeEfnrtv\\'"?])/g;
  function xn(e, r) {
    var t = r.charAt(0);
    if (t === "c") {
      var n = r.charAt(1);
      return n === "?" ? "\u007f" : String.fromCharCode(n.charCodeAt(0) & 31);
    }
    if (t === "x" || t === "u" || t === "U") {
      var o = parseInt(r.slice(1), 16);
      if (o > 1114111)
        return e;
      return String.fromCharCode.apply(null, o > 65535 ? [55232 + (o >> 10), 56320 + (o & 1023)] : [o]);
    }
    if (t >= "0" && t <= "7")
      return String.fromCharCode(parseInt(r, 8) & 255);
    var u = pn.indexOf(r);
    return u < 0 ? r : cn.charAt(u);
  }
  function An(e) {
    return e.replace(_n, xn).split("\x00")[0];
  }
  function Rn(e, r) {
    return Pe.lastIndex = r, !!Pe.exec(e)[1];
  }
  function En(e, r, t) {
    if (!t)
      t = {};
    var n = t.escape || "\\", o = t.splitUnquoted === true ? ` 	
` : typeof t.splitUnquoted === "string" ? t.splitUnquoted : "", u = "(\\" + n + `['"$\\` + n + It + "]|\\$\\$|\\$(?!" + Ct.slice(2) + `)|[^\\s'"$` + It + "])+", s = '"(?:\\' + n + '[\\s\\S]|[^"\\' + n + '])*"', i = new RegExp(["(" + Ht + ")", "(" + Ct + "|" + u + "|" + s + "|" + dn + ")+"].join("|"), "g"), h2 = yn(e, i);
    if (h2.length === 0)
      return [];
    if (!r)
      r = {};
    var N = false;
    return h2.map(function(_) {
      var w = _[0];
      if (!w || N)
        return;
      if (Tt.test(w))
        return { op: w };
      var M = false, K = false, g = "", k = [], ee = false, q = null, L = false, H;
      function ne() {
        H += 1;
        var C, B, l = w.charAt(H);
        if (l === "{") {
          if (H += 1, w.charAt(H) === "}")
            throw Error("Bad substitution: " + w.slice(H - 2, H + 1));
          var f = 1;
          C = H;
          while (f > 0 && C < w.length) {
            if (w.charAt(C) === "{" && w.charAt(C - 1) === "$")
              f += 1;
            else if (w.charAt(C) === "}")
              f -= 1;
            C += 1;
          }
          if (f !== 0)
            throw Error("Bad substitution: " + w.slice(H));
          C -= 1, B = w.slice(H, C), H = C;
        } else if (/[*@#?$!-]/.test(l))
          B = l;
        else {
          var Y = w.slice(H);
          if (C = Y.match(/[^\w\d_]/), !C)
            B = Y, H = w.length;
          else
            B = Y.slice(0, C.index), H += C.index - 1;
        }
        return gn(r, "", B);
      }
      function X() {
        if (q === null)
          return;
        if (q === 0) {
          if (g !== "")
            k[k.length] = g, g = "";
        } else {
          k[k.length] = g, g = "";
          for (var C = 1;C < q; C += 1)
            k[k.length] = "";
        }
        q = null;
      }
      for (H = 0;H < w.length; H++) {
        var T = w.charAt(H);
        if (o && T !== be)
          X();
        if (L = L || !M && (T === "*" || T === "?"), K)
          g += T, K = false;
        else if (M)
          if (T === M)
            M = false;
          else if (M == Xe)
            g += T;
          else if (T === n)
            if (H += 1, T = w.charAt(H), T === kt || T === n || T === be)
              g += T;
            else
              g += n + T;
          else if (T === be)
            g += ne();
          else
            g += T;
        else if (T === kt || T === Xe)
          M = T, ee = true;
        else if (Tt.test(T))
          return { op: w };
        else if (hn.test(T)) {
          N = true;
          var V = { comment: e.slice(_.index + H + 1) };
          if (g.length)
            return [g, V];
          return [V];
        } else if (T === n)
          K = true;
        else if (T === be && w.charAt(H + 1) === Xe && Rn(w, H))
          X(), ee = true, g += An(w.slice(H + 2, Pe.lastIndex - 1)), H = Pe.lastIndex - 1;
        else if (T === be) {
          var A = ne();
          if (!o)
            g += A;
          else
            for (var I = 0;I < A.length; I += 1) {
              var a = A.charAt(I);
              if (o.indexOf(a) < 0)
                X(), g += a;
              else if (q === null)
                q = a === " " || a === "\t" || a === `
` ? 0 : 1;
              else if (a !== " " && a !== "\t" && a !== `
`)
                q += 1;
            }
        } else
          g += T;
      }
      if (L)
        return { op: "glob", pattern: g };
      if (o) {
        if (q !== null && q > 0) {
          k[k.length] = g, g = "";
          for (var Q = 1;Q < q; Q += 1)
            k[k.length] = "";
        }
        if (g !== "" || ee && k.length === 0)
          k[k.length] = g;
        return k;
      }
      return g;
    }).reduce(function(_, w) {
      if (typeof w > "u")
        return _;
      return [].concat(w).forEach(function(M) {
        _[_.length] = M;
      }), _;
    }, []);
  }
  Lt.exports = function(r, t, n) {
    var o = En(r, t, n);
    if (typeof t !== "function")
      return o;
    return o.reduce(function(u, s) {
      if (typeof s === "object")
        return u[u.length] = s, u;
      var i = s.split(RegExp("(" + ge + ".*?" + ge + ")", "g"));
      if (i.length === 1)
        return u[u.length] = i[0], u;
      return i.filter(Boolean).forEach(function(h2) {
        u[u.length] = mn.test(h2) ? JSON.parse(h2.split(ge)[1]) : h2;
      }), u;
    }, []);
  };
});
var Vt = typeof self < "u" && self.location && self.location.origin !== "null" ? new URL(self.location.origin + self.location.pathname + location.search) : new URL("https://github.com/cfworker");
var Yt = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
var Jt = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
var er = /^(\d\d):(\d\d):(\d\d)(\.\d+)?(z|[+-]\d\d(?::?\d\d)?)?$/i;
var tr = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i;
var rr = /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
var nr = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
var sr = /^(?:(?:https?|ftp):\/\/)(?:\S+(?::\S*)?@)?(?:(?!10(?:\.\d{1,3}){3})(?!127(?:\.\d{1,3}){3})(?!169\.254(?:\.\d{1,3}){2})(?!192\.168(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)(?:\.(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
var or = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
var ur = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
var ir = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
var ar = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
var fr = (e) => {
  if (e[0] === '"')
    return false;
  let [r, t, ...n] = e.split("@");
  if (!r || !t || n.length !== 0 || r.length > 64 || t.length > 253)
    return false;
  if (r[0] === "." || r.endsWith(".") || r.includes(".."))
    return false;
  if (!/^[a-z0-9.-]+$/i.test(t) || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(r))
    return false;
  return t.split(".").every((o) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(o));
};
var lr = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
var dr = /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i;
var pr = (e) => e.length > 1 && e.length < 80 && (/^P\d+([.,]\d+)?W$/.test(e) || /^P[\dYMDTHS]*(\d[.,]\d+)?[YMDHS]$/.test(e) && /^P([.,\d]+Y)?([.,\d]+M)?([.,\d]+D)?(T([.,\d]+H)?([.,\d]+M)?([.,\d]+S)?)?$/.test(e));
function le(e) {
  return e.test.bind(e);
}
var Me = { date: Je, time: et.bind(undefined, false), "date-time": $r, duration: pr, uri: gr, "uri-reference": le(rr), "uri-template": le(nr), url: le(sr), email: fr, hostname: le(tr), ipv4: le(lr), ipv6: le(dr), regex: xr, uuid: le(or), "json-pointer": le(ur), "json-pointer-uri-fragment": le(ir), "relative-json-pointer": le(ar) };
function cr(e) {
  return e % 4 === 0 && (e % 100 !== 0 || e % 400 === 0);
}
function Je(e) {
  let r = e.match(Yt);
  if (!r)
    return false;
  let t = +r[1], n = +r[2], o = +r[3];
  return n >= 1 && n <= 12 && o >= 1 && o <= (n == 2 && cr(t) ? 29 : Jt[n]);
}
function et(e, r) {
  let t = r.match(er);
  if (!t)
    return false;
  let n = +t[1], o = +t[2], u = +t[3], s = !!t[5];
  return (n <= 23 && o <= 59 && u <= 59 || n == 23 && o == 59 && u == 60) && (!e || s);
}
var hr = /t|\s/i;
function $r(e) {
  let r = e.split(hr);
  return r.length == 2 && Je(r[0]) && et(true, r[1]);
}
var mr = /\/|:/;
var yr = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
function gr(e) {
  return mr.test(e) && yr.test(e);
}
var _r = /[^\\]\\Z/;
function xr(e) {
  if (_r.test(e))
    return false;
  try {
    return new RegExp(e, "u"), true;
  } catch (r) {
    return false;
  }
}
var Ar = /^[A-Za-z]:\//;
function Ee(e = "") {
  if (!e)
    return e;
  return e.replace(/\\/g, "/").replace(Ar, (r) => r.toUpperCase());
}
var Er = /^[/\\](?![/\\])|^[/\\]{2}(?!\.)|^[A-Za-z]:[/\\]/;
function br() {
  return "/";
}
var ve = function(...e) {
  e = e.map((n) => Ee(n));
  let r = "", t = false;
  for (let n = e.length - 1;n >= -1 && !t; n--) {
    let o = n >= 0 ? e[n] : br();
    if (!o || o.length === 0)
      continue;
    r = `${o}/${r}`, t = ye(o);
  }
  if (r = ze(r, !t), t && !ye(r))
    return `/${r}`;
  return r.length > 0 ? r : ".";
};
function ze(e, r) {
  let t = "", n = 0, o = -1, u = 0, s = null;
  for (let i = 0;i <= e.length; ++i) {
    if (i < e.length)
      s = e[i];
    else if (s === "/")
      break;
    else
      s = "/";
    if (s === "/") {
      if (o === i - 1 || u === 1)
        ;
      else if (u === 2) {
        if (t.length < 2 || n !== 2 || t[t.length - 1] !== "." || t[t.length - 2] !== ".") {
          if (t.length > 2) {
            let h2 = t.lastIndexOf("/");
            if (h2 === -1)
              t = "", n = 0;
            else
              t = t.slice(0, h2), n = t.length - 1 - t.lastIndexOf("/");
            o = i, u = 0;
            continue;
          } else if (t.length > 0) {
            t = "", n = 0, o = i, u = 0;
            continue;
          }
        }
        if (r)
          t += t.length > 0 ? "/.." : "..", n = 2;
      } else {
        if (t.length > 0)
          t += `/${e.slice(o + 1, i)}`;
        else
          t = e.slice(o + 1, i);
        n = i - o - 1;
      }
      o = i, u = 0;
    } else if (s === "." && u !== -1)
      ++u;
    else
      u = -1;
  }
  return t;
}
var ye = function(e) {
  return Er.test(e);
};
var ft = function(e, r) {
  let t = Ee(e).split("/"), n = "";
  for (let o = t.length - 1;o >= 0; o--) {
    let u = t[o];
    if (u) {
      n = u;
      break;
    }
  }
  return r && n.endsWith(r) ? n.slice(0, -r.length) : n;
};
var Sn = Kt(wt(), 1);
var Mt = vt();
var Dt = Pt();
var $s = Sn.default;

// node_modules/@cmodjs/core/utils/paths.js
var missingPath = /(?:^|: )(?:ENOENT|ENOTDIR)\b/;
function isMissing(error) {
  return missingPath.test(messageOf(error));
}
function ifMissing(value) {
  return (error) => {
    if (isMissing(error))
      return value;
    throw error;
  };
}
var homePrefix = /^(~|\$HOME|\$CLAUDE_CONFIG_DIR)(?=\/|$)/;
function expandHome(path, home, configRoot = `${home}/.claude`) {
  const prefix = homePrefix.exec(path)?.[0];
  if (prefix === undefined)
    return path;
  return `${prefix === "$CLAUDE_CONFIG_DIR" ? configRoot : home}${path.slice(prefix.length)}`;
}
function relativePath(base, path) {
  if (path === base)
    return "";
  const prefix = base === "/" ? "/" : `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

// node_modules/@cmodjs/core/runtime/deadline.js
var longestMs = 600000;
var callDeadline = { ms: 30000 };
var listenerMs = 1e4;
var hookMs = 1e4;

class PassedTimeout extends Error {
}
var timers = globalThis;
function listenerOf(name, method, args) {
  const hasMatcher = typeof args[1] === "function";
  const listener = hasMatcher ? args[1] : args[0];
  const options = (hasMatcher ? args[2] : args[1]) ?? {};
  if (typeof listener !== "function")
    throw new Error(`${name}: ${method} takes a listener, or a matcher and then a listener.`);
  const { timeoutMs, onFailure } = options;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > longestMs))
    throw new Error(`${name}: ${method}'s timeoutMs is ${String(timeoutMs)}. Give a whole number of milliseconds above 0 and at most ${longestMs}.`);
  if (onFailure !== undefined && onFailure !== "pass" && onFailure !== "refuse")
    throw new Error(`${name}: ${method}'s onFailure is ${String(onFailure)}. Give 'pass' or 'refuse'.`);
  return { matcher: hasMatcher ? args[0] : undefined, listener, options };
}
async function withinTime(clock, method, { timeoutMs = listenerMs }, cancel, run) {
  const controller = new AbortController;
  const deadline = await clock.now() + timeoutMs;
  cancel.throwIfAborted();
  let timer;
  let cancelled = () => {
    return;
  };
  const passed = new Promise((_resolve, reject) => {
    timer = timers.setTimeout(() => {
      controller.abort();
      reject(new PassedTimeout(`${method} passed its ${timeoutMs / 1000} s timeout`));
    }, timeoutMs);
    cancelled = () => reject(cancel.reason);
    cancel.addEventListener("abort", cancelled, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run({ deadline, signal: AbortSignal.any([controller.signal, cancel]) })), passed]);
  } finally {
    timers.clearTimeout(timer);
    cancel.removeEventListener("abort", cancelled);
  }
}
var abortGraceMs = 1000;
function settledAfterAbort(work, signal) {
  if (signal === undefined)
    return work;
  return new Promise((resolve, reject) => {
    let timer;
    const giveUp = () => void (timer = timers.setTimeout(() => reject(signal.reason), abortGraceMs));
    if (signal.aborted)
      giveUp();
    else
      signal.addEventListener("abort", giveUp, { once: true });
    work.then(resolve, reject).finally(() => {
      timers.clearTimeout(timer);
      signal.removeEventListener("abort", giveUp);
    });
  });
}
function beforeDeadline(clock, { ms, job }, call, run) {
  const passed = new AbortController;
  return new Promise((resolve, reject) => {
    const deadline = job === undefined ? `its ${ms / 1000} s deadline` : `the ${ms / 1000} s deadline of ${job}`;
    const timer = clock.after(ms, () => {
      const error = new Error(`${call} passed ${deadline}`);
      reject(error);
      passed.abort(error);
    });
    run(passed.signal).then((value) => {
      timer.cancel();
      resolve(value);
    }, (error) => {
      timer.cancel();
      reject(error);
    });
  });
}

// node_modules/@cmodjs/core/runtime/dependencies.js
var cmodPluginName = "cmod";
var loadedMethod = "cmod:isLoaded";
async function answerCall(name, api, e) {
  const method = Object.hasOwn(api, e.method) ? api[e.method] : undefined;
  if (method === undefined)
    return { deny: `${name} has no method ${e.method}.` };
  try {
    return { value: await method(e.input) };
  } catch (error) {
    return { deny: `${name}: ${messageOf(error)}` };
  }
}
function dependencyCalls(claude, within) {
  const methodsOf = (to) => new Proxy({}, { get: (_methods, method) => typeof method === "string" && method !== "then" ? (input) => within(`mod.dependencies.${to}.${method}`, claude.cmod.call({ to, method, input })) : undefined });
  return new Proxy({}, { get: (_dependencies, to) => typeof to === "string" && to !== "then" ? methodsOf(to) : undefined });
}
function withBareRefusals(claude) {
  const prefix = `${claude.plugin.name}: $.cmod.call: `;
  const call = (input) => claude.cmod.call(input).catch((error) => {
    const message = messageOf(error);
    throw message.startsWith(prefix) ? new Error(message.slice(prefix.length), { cause: error }) : error;
  });
  return { ...claude, cmod: { call } };
}
function answeringOwnCalls(claude, router) {
  const name = claude.plugin.name;
  const call = async (input) => {
    if (input.to !== name)
      return claude.cmod.call(input);
    const answer = await router.dispatch("cmod.call", { ...input, caller: name }, async () => ({ deny: `${name} has no method ${input.method}.` }));
    if (answer.deny !== undefined)
      throw new Error(answer.deny);
    return answer.value;
  };
  return { ...claude, cmod: { call } };
}
function stillInstalling(name) {
  return `${name} is installing. Try again when it's ready.`;
}
function isStillInstalling(name, error) {
  return messageOf(error).endsWith(stillInstalling(name));
}
function didNotAnswer(name) {
  return `${name} did not answer in time, so Claude Code went on without it.`;
}
var overranHook = `it ran past the ${hookMs / 1000} s Claude Code gives a hook`;
function isUnanswered(error) {
  const refusals = [stillInstalling(""), didNotAnswer(""), `: ${overranHook}`];
  for (let cause = error;cause !== undefined; cause = cause instanceof Error ? cause.cause : undefined) {
    const message = messageOf(cause);
    if (refusals.some((refusal) => message.endsWith(refusal)))
      return true;
  }
  return false;
}

// node_modules/@cmodjs/core/runtime/tool-calls.js
function toolCalls(claude, router) {
  let mainAgentType;
  const agentIds = new Map;
  const noteAgent = (e) => {
    if (e.agent_id === undefined)
      mainAgentType = e.agent_type;
  };
  router.add("classic.SessionStart", (e, next) => {
    noteAgent(e);
    return next(e);
  });
  router.add("classic.UserPromptSubmit", (e, next) => {
    noteAgent(e);
    return next(e);
  });
  router.add("tool.call", async (e, next) => {
    if (e.agentId === undefined)
      return next(e);
    agentIds.set(e.tool_use_id, e.agentId);
    try {
      return await next(e);
    } finally {
      agentIds.delete(e.tool_use_id);
    }
  });
  return {
    async agentOf(toolUseId) {
      const agentId = toolUseId === undefined ? undefined : agentIds.get(toolUseId);
      const agentType = agentId === undefined ? mainAgentType : (await claude.agent.list()).find((agent) => agent.id === agentId)?.type;
      return { ...agentId === undefined ? {} : { agentId }, ...agentType === undefined ? {} : { agentType } };
    }
  };
}

// node_modules/@cmodjs/core/runtime/before.js
function withAnswer(change, answer) {
  if (change.type === Message && answer.output !== undefined && change.message.type === ToolResult)
    return { ...change, message: { ...change.message, output: answer.output } };
  if (change.type === Message && answer.text !== undefined)
    return { ...change, message: { ...change.message, text: answer.text } };
  if (change.type === Message && answer.input !== undefined && change.message.type === ToolCall)
    return { ...change, message: { ...change.message, input: answer.input } };
  if (change.type === TaskStart) {
    const { agentType, model } = answer.owner ?? {};
    return { ...change, task: { ...change.task, ...answer.title === undefined ? {} : { title: answer.title }, ...agentType === undefined ? {} : { agentType }, ...model === undefined ? {} : { model } } };
  }
  return change;
}
var methodOf = (prefix, event) => `${prefix}${Object.entries(sessionEvents).find(([, each]) => each === event)?.[0] ?? event}`;
var beforeAnswerKeys = {
  prompt: ["text", "note", "title", "refuse"],
  note: ["text"],
  skill: ["text"],
  instructionFile: ["text", "refuse"],
  attachedFile: ["text", "refuse"],
  reply: ["text"],
  toolCall: ["input", "result", "refuse", "note"],
  toolResult: ["output", "isError", "note"],
  notice: ["text"],
  taskStart: ["prompt", "title", "owner", "isAsync", "refuse"],
  turnEnd: ["refuse", "note"],
  contextEnd: ["refuse", "summary"]
};
function foldBefore(event, change, askers, report) {
  return foldAnswers(methodOf("before", event), beforeAnswerKeys[event], ["refuse", "result"], change, askers, report, withAnswer);
}
function takenAnswer(method, takes, answer) {
  if (answer === undefined || answer === null || answer === false)
    return;
  if (typeof answer !== "object" || Array.isArray(answer))
    throw new Error(`it answered ${JSON.stringify(answer)}, but ${method} takes an object or nothing: ${takes.map((key) => `{ ${key} }`).join(", ") || "no answer"}.`);
  const unread = Object.keys(answer).filter((key) => !takes.includes(key));
  if (unread.length > 0)
    throw new Error(`it answered ${unread.join(" and ")}, which ${method} does not take. It takes ${takes.map((key) => `{ ${key} }`).join(", ") || "no answer"}.`);
  return answer;
}
async function foldAnswers(method, takes, ends, change, askers, report, applied = (same) => same) {
  let latest = change;
  let result;
  for (const ask of askers) {
    try {
      const answer = takenAnswer(method, takes, await ask(latest));
      if (typeof answer !== "object" || answer === null)
        continue;
      const given = answer;
      const notes = [result?.["note"], given["note"]].filter((note) => typeof note === "string");
      result = { ...result, ...given, ...notes.length === 0 ? {} : { note: notes.join(`

`) } };
      if (ends.some((key) => given[key] !== undefined))
        return result;
      latest = applied(latest, answer);
    } catch (error) {
      report(error);
    }
  }
  return result;
}

// node_modules/@cmodjs/core/runtime/device.js
var cmodAppId = "1fd8a8ee972047c4a89640fd51048522";
var sha256Block = 64;
var systems = { Darwin: "darwin", Linux: "linux" };
var machines = { arm64: "arm64", aarch64: "arm64", x86_64: "x64", amd64: "x64" };
var platformUuid = /"IOPlatformUUID" = "([0-9A-Fa-f-]{36})"/;
var machineId = /^[0-9a-f]{32}$/;
var machineIdFiles = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

class MissingMachineId extends Error {
}
async function readDevice(claude) {
  const output = async (argv) => {
    const { exitCode, stdout, stderr } = await claude.process.run(argv);
    if (exitCode !== 0)
      throw new Error(`cmod could not read this computer: ${argv.join(" ")} ${formatExit(exitCode, stderr)}`);
    return stdout.trim();
  };
  const [system = "", node = "", machine = ""] = (await output(["uname", "-snm"])).split(/\s+/);
  const os = systems[system];
  const arch = machines[machine];
  if (os === undefined)
    throw new Error(`cmod reads the device of macOS and Linux, and this computer runs ${system}.`);
  if (arch === undefined)
    throw new Error(`cmod reads the device of arm64 and x64 computers, and this one is ${machine}.`);
  if (os === "linux")
    return { id: await appSpecific(await linuxMachineId(claude.fs)), name: node, os, arch };
  const [platform, name] = await Promise.all([output(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]), output(["scutil", "--get", "LocalHostName"])]);
  const uuid = platformUuid.exec(platform)?.[1];
  if (uuid === undefined)
    throw new Error("cmod could not read this computer: ioreg -rd1 -c IOPlatformExpertDevice names no IOPlatformUUID.");
  return { id: await appSpecific(uuid.replaceAll("-", "").toLowerCase()), name, os, arch };
}
async function linuxMachineId(fs) {
  for (const path of machineIdFiles) {
    const id = (await fs.read(path).catch(ifMissing(""))).trim();
    if (machineId.test(id))
      return id;
  }
  throw new MissingMachineId(`cmod could not read this computer: neither ${machineIdFiles.join(" nor ")} holds a machine id.`);
}
async function appSpecific(machine) {
  if (!machineId.test(machine))
    throw new Error("cmod could not read this computer: its machine id is not 32 hex digits.");
  const id = (await hmacSha256(bytesOf(machine), bytesOf(cmodAppId))).slice(0, 16);
  id[6] = (id[6] ?? 0) & 15 | 64;
  id[8] = (id[8] ?? 0) & 63 | 128;
  return [...id].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function hmacSha256(key, message) {
  const sha256 = async (...parts) => new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(parts.flatMap((part) => [...part]))));
  const padded = new Uint8Array(sha256Block);
  padded.set(key);
  return sha256(padded.map((byte) => byte ^ 92), await sha256(padded.map((byte) => byte ^ 54), message));
}
function bytesOf(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

// node_modules/@cmodjs/core/runtime/router.js
var unaborted = new AbortController().signal;
function createRouter() {
  const routes = new Map;
  return {
    add(event, hook, failed) {
      const route = { hook, ...failed === undefined ? {} : { failed } };
      routes.set(event, [...routes.get(event) ?? [], route]);
      return {
        remove() {
          const chain = (routes.get(event) ?? []).filter((each) => each !== route);
          if (chain.length === 0)
            routes.delete(event);
          else
            routes.set(event, chain);
        }
      };
    },
    dispatch(event, e, next, signal = unaborted) {
      const chain = routes.get(event);
      const call = async (index, current) => {
        const route = chain?.[index];
        if (route === undefined)
          return next(current);
        return route.hook(current, Object.assign((passed) => call(index + 1, passed), { signal }));
      };
      return call(0, e);
    },
    dispatchFailure(event, e, error, next, called) {
      const chain = routes.get(event);
      const fail = async (index, current) => {
        const route = chain?.[index];
        if (route === undefined)
          return next(current);
        const answer = await route.failed?.(current, error, Object.assign((passed) => fail(index + 1, passed), { signal: unaborted, called }));
        return answer === undefined ? fail(index + 1, current) : answer;
      };
      return fail(0, e);
    }
  };
}

// node_modules/@cmodjs/core/runtime/interfaces.js
var styleInterface = "cmod/Style";
var interfaceMethods = { providers: "cmod:providers", provider: "cmod:provider", provided: "cmod:provided", listen: "cmod:listenProvided", unlisten: "cmod:unlistenProvided", tell: "cmod:tellProvided", ask: "cmod:askProvided", heard: "cmod:heard" };
var providerHoldMs = hookMs / 4;
function checkInterfaceName(name) {
  if (!interfaceName.test(name))
    throw new Error(`${name} is no interface name, such as demo/Platform.`);
}
function methodName(name, method) {
  return `${name}.${method}`;
}
function providerClient(name, identity, call, listen) {
  return new Proxy(identity, {
    get: (known, key) => {
      if (typeof key !== "string" || key === "then")
        return;
      if (key === "mod" || key === "program" || key === "device")
        return known[key];
      const event = /^(on|before)([A-Z]\w*)$/.exec(key);
      if (event === null)
        return (...args) => call(key, args);
      return (...args) => {
        const { matcher, listener, options } = listenerOf(name, key, args);
        return listen(event[1], event[2] ?? "", matcher, listener, options);
      };
    }
  });
}
function createProviders({ name, call, changed, after, report }) {
  const provided = new Map;
  const heard = new Map;
  let nextListener = 0;
  const run = async ({ interface: named, method, args }) => {
    const runs = provided.get(named)?.[method];
    if (runs === undefined)
      throw new Error(`${name} provides no ${named}.${method}.`);
    return await runs(...args) ?? null;
  };
  const answer = (method, asked, caller, signal) => {
    if (method === interfaceMethods.heard && caller === cmodPluginName)
      return (async () => await heard.get(asked.id)?.(asked.payload, signal) ?? null)();
    return method === interfaceMethods.provided && asked.program === undefined ? run(asked) : undefined;
  };
  const client = (named, identity) => providerClient(named, identity, (method, args) => {
    const asked = { interface: named, method, args, ...identity };
    return beforeDeadline({ after }, callDeadline, methodName(named, method), () => identity.mod === name && identity.program === undefined ? run(asked) : call(identity.program === undefined ? identity.mod : cmodPluginName, interfaceMethods.provided, asked));
  }, (kind, event, matcher, listener, options) => {
    const id = `${named}#${nextListener += 1}`;
    heard.set(id, listener);
    call(cmodPluginName, interfaceMethods.listen, { id, interface: named, kind, event, ...identity, ...matcher === undefined ? {} : { matcher: sentMatcher(matcher) }, ...options }).catch((error) => {
      heard.delete(id);
      report(error);
    });
    return {
      remove() {
        if (heard.delete(id))
          call(cmodPluginName, interfaceMethods.unlisten, { id }).catch(report);
      }
    };
  });
  return {
    provided: () => [...provided.keys()],
    provide(named, methods) {
      checkInterfaceName(named);
      provided.set(named, methods);
      changed();
      const send = (method, event, payload) => new Promise((resolve) => after(0, () => resolve(call(cmodPluginName, method, { interface: named, event, payload }))));
      return {
        remove() {
          if (provided.get(named) === methods && provided.delete(named))
            changed();
        },
        tell: (event, payload) => void send(interfaceMethods.tell, event, payload).catch(report),
        ask: (event, payload) => send(interfaceMethods.ask, event, payload)
      };
    },
    async providers(named) {
      const listed = await call(cmodPluginName, interfaceMethods.providers, { name: named });
      return [...listed.mods.map((mod) => client(named, { mod, device: listed.device })), ...listed.programs.map((identity) => client(named, identity))];
    },
    answer
  };
}

// node_modules/@cmodjs/core/runtime/programs.js
function lastLineOf(text) {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed.slice(trimmed.lastIndexOf(`
`) + 1).trim();
}
function cmodError(stderr, command) {
  const line = lastLineOf(stderr) ?? "";
  const prefix = `cmod ${command}: `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}
async function readLines(stream, onLine) {
  let pending = "";
  let lastError = "";
  let piece = await stream.next();
  while (piece.done !== true) {
    if (piece.value.stream === "stderr") {
      lastError = lastLineOf(piece.value.text) ?? lastError;
    } else {
      const lines = `${pending}${piece.value.text}`.split(`
`);
      pending = lines.pop() ?? "";
      for (const text of lines)
        onLine(text);
    }
    piece = await stream.next();
  }
  if (pending !== "")
    onLine(pending);
  return { code: piece.value.code, lastError };
}
function spawnCmod(claude, args, session, env = {}) {
  return claude.process.spawn({ argv: ["cmod", ...args], env: { ...env, CLAUDE_CODE_SESSION_ID: session } });
}
async function cmodStore(claude) {
  return storeFolder({ HOME: await claude.env.home(), XDG_DATA_HOME: await claude.env.dataHome() });
}
async function newestCmodVersion(claude) {
  const store = await cmodStore(claude);
  return readCmodVersion({
    list: async (folder) => (await claude.fs.list(folder).catch(ifMissing([]))).map((entry) => entry.name),
    exists: async (path) => await claude.fs.stat(path).catch(ifMissing(undefined)) !== undefined
  }, store);
}
async function runCmod(claude, args, session) {
  const lines = [];
  const { code, lastError } = await readLines(spawnCmod(claude, args, session), (line) => void lines.push(line));
  if (code !== 0)
    throw new Error(cmodError(lastError, args[0]) || `cmod ${args.slice(0, 2).join(" ")} ${formatExit(code, "")}.`);
  return lines.join(`
`);
}
function spawnedAfter(ready, spawn) {
  let resolve = () => {
    return;
  };
  let reject = () => {
    return;
  };
  const result = new Promise((resolved, rejected) => {
    resolve = resolved;
    reject = rejected;
  });
  result.catch(() => {
    return;
  });
  const stream = async function* () {
    try {
      await ready;
      const ended = yield* spawn();
      resolve(ended);
      return ended;
    } finally {
      reject(new Error("cmod: the stream closed before the program ended."));
    }
  }();
  return Object.assign(stream, { result });
}
function locatingPrograms(claude) {
  let folder;
  let names = new Set;
  let downloading;
  const located = (argv) => {
    const [name, ...rest] = argv;
    return folder !== undefined && name !== undefined && (name === "cmod" || names.has(name)) ? [`${folder}/${name}`, ...rest] : argv;
  };
  const waiting = (argv) => argv[0] === "cmod" ? downloading : undefined;
  return {
    claude: {
      ...claude,
      process: {
        run: (argv, init) => {
          const ready = waiting(argv);
          return ready === undefined ? claude.process.run(located(argv), init) : ready.then(() => claude.process.run(located(argv), init));
        },
        spawn: (request) => {
          const ready = waiting(request.argv);
          const spawn = () => claude.process.spawn({ ...request, argv: located(request.argv) });
          return ready === undefined ? spawn() : spawnedAfter(ready, spawn);
        }
      }
    },
    waitFor(download) {
      const current = download.then(() => {
        if (downloading === current)
          downloading = undefined;
      });
      current.catch(() => {
        return;
      });
      downloading = current;
    },
    async refresh() {
      const programs = `${await cmodStore(claude)}/programs`;
      names = new Set((await claude.fs.list(programs).catch(ifMissing([]))).map((entry) => entry.name));
      folder = programs;
    }
  };
}

// node_modules/@cmodjs/core/utils/parse-shell.js
var markerPattern = /\u0001(\d+)\u0001/g;
var descriptorPattern = /[0-9]+(?=[<>])/y;
var assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
var dynamicPattern = /[$`]/;
var homePrefix2 = /^\$HOME(?=\/|$)/;
var clusterPattern = /^-[A-Za-z0-9]{2,}$/;
var separators = ";&|()<>";
var redirectOperators = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<", "<>", "<&", "<<<"]);
var writeRedirects = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
var sequenceOperators = new Set([";", "&", "&&", "||", "|", "|&"]);
var casePatternStarts = new Set([";;", ";&", ";;&"]);
var reservedWords = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "{", "}", "!"]);
var shells = new Set(["sh", "bash", "zsh"]);
var findActions = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
var gitValuedOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
var nonGetoptPrograms = new Set([
  "find",
  "java",
  "javac",
  "go",
  "gcc",
  "g++",
  "clang",
  "clang++",
  "swift",
  "swiftc",
  "xcodebuild",
  "xcrun",
  "ffmpeg",
  "ffprobe",
  "openssl",
  "plutil",
  "defaults",
  "security",
  "codesign"
]);
var grep = {
  valued: "efmABCdD",
  longValued: ["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--directories", "--devices", "--binary-files", "--label", "--include", "--exclude", "--exclude-dir", "--exclude-from"],
  scriptOptions: ["-e", "-f", "--regexp", "--file"]
};
var awk = {
  valued: "fFvi",
  longValued: ["--file", "--field-separator", "--assign", "--include", "--source"],
  scriptOptions: ["-f", "--file", "--source"],
  takesAssignments: true,
  inPlaceOptions: ["-i", "--include"]
};
var sed = {
  valued: "efl",
  optional: "iI",
  longValued: ["--expression", "--file", "--line-length"],
  scriptOptions: ["-e", "-f", "--expression", "--file"],
  inPlaceOptions: ["-i", "-I", "--in-place"]
};
var perl = {
  valued: "eEIMmF",
  optional: "ixdDC",
  scriptOptions: ["-e", "-E"],
  inPlaceOptions: ["-i"]
};
var fileWriters = new Map([
  ["tee", {}],
  ["rm", {}],
  ["touch", { valued: "drt", longValued: ["--date", "--reference", "--time"] }],
  ["truncate", { valued: "sr", longValued: ["--size", "--reference"] }]
]);
var copyTarget = { valued: "tS", longValued: ["--target-directory", "--suffix"], targetOptions: ["-t", "--target-directory"] };
var copyPrograms = new Map([
  ["cp", { ...copyTarget, sources: "reads" }],
  ["mv", { ...copyTarget, sources: "writes" }],
  ["ln", { ...copyTarget, sources: undefined, linksHere: true }],
  ["rsync", {
    valued: "efBTM",
    longValued: [
      "--rsh",
      "--rsync-path",
      "--filter",
      "--exclude",
      "--include",
      "--exclude-from",
      "--include-from",
      "--files-from",
      "--temp-dir",
      "--compare-dest",
      "--copy-dest",
      "--link-dest",
      "--backup-dir",
      "--suffix",
      "--chmod",
      "--chown",
      "--usermap",
      "--groupmap",
      "--timeout",
      "--contimeout",
      "--bwlimit",
      "--log-file",
      "--log-file-format",
      "--out-format",
      "--password-file",
      "--port",
      "--sockopts",
      "--max-size",
      "--min-size",
      "--max-delete",
      "--partial-dir",
      "--block-size",
      "--modify-window",
      "--iconv",
      "--checksum-choice",
      "--compress-choice",
      "--compress-level",
      "--remote-option",
      "--info",
      "--debug",
      "--address",
      "--write-batch",
      "--only-write-batch",
      "--read-batch",
      "--protocol",
      "--skip-compress"
    ],
    sources: "reads",
    skipsRemote: true
  }]
]);
var fetchers = new Map([
  ["curl", {
    valued: "AbcCdDeEFHKmoPQrTtuUwxXyYz",
    longValued: [
      "--url",
      "--data",
      "--data-raw",
      "--data-binary",
      "--data-urlencode",
      "--data-ascii",
      "--json",
      "--form",
      "--form-string",
      "--header",
      "--proxy-header",
      "--user",
      "--user-agent",
      "--referer",
      "--output",
      "--output-dir",
      "--cookie",
      "--cookie-jar",
      "--request",
      "--proxy",
      "--proxy-user",
      "--preproxy",
      "--noproxy",
      "--max-time",
      "--connect-timeout",
      "--retry",
      "--retry-delay",
      "--retry-max-time",
      "--range",
      "--continue-at",
      "--upload-file",
      "--write-out",
      "--cert",
      "--cert-type",
      "--key",
      "--key-type",
      "--cacert",
      "--capath",
      "--ciphers",
      "--config",
      "--dump-header",
      "--interface",
      "--limit-rate",
      "--max-filesize",
      "--max-redirs",
      "--resolve",
      "--connect-to",
      "--oauth2-bearer",
      "--aws-sigv4",
      "--unix-socket",
      "--abstract-unix-socket",
      "--variable",
      "--url-query",
      "--trace",
      "--trace-ascii",
      "--stderr",
      "--keepalive-time",
      "--local-port",
      "--dns-servers",
      "--doh-url",
      "--quote",
      "--telnet-option",
      "--time-cond",
      "--speed-limit",
      "--speed-time",
      "--etag-save",
      "--etag-compare",
      "--hsts",
      "--alt-svc",
      "--mail-from",
      "--mail-rcpt",
      "--mail-auth",
      "--pass",
      "--proto",
      "--proto-redir",
      "--pubkey",
      "--socks4",
      "--socks4a",
      "--socks5",
      "--socks5-hostname"
    ]
  }],
  ["wget", {
    valued: "aoeiBtOTwQPlARDIXU",
    longValued: [
      "--output-file",
      "--append-output",
      "--execute",
      "--input-file",
      "--base",
      "--tries",
      "--output-document",
      "--timeout",
      "--dns-timeout",
      "--connect-timeout",
      "--read-timeout",
      "--wait",
      "--waitretry",
      "--quota",
      "--limit-rate",
      "--directory-prefix",
      "--level",
      "--accept",
      "--reject",
      "--domains",
      "--exclude-domains",
      "--include-directories",
      "--exclude-directories",
      "--user-agent",
      "--header",
      "--user",
      "--password",
      "--http-user",
      "--http-password",
      "--post-data",
      "--post-file",
      "--body-data",
      "--body-file",
      "--method",
      "--referer",
      "--load-cookies",
      "--save-cookies",
      "--certificate",
      "--private-key",
      "--ca-certificate",
      "--ca-directory",
      "--bind-address",
      "--cut-dirs",
      "--default-page",
      "--restrict-file-names",
      "--local-encoding",
      "--remote-encoding"
    ]
  }]
]);
var su = { valued: "cgGsw", longValued: ["--command", "--session-command", "--group", "--supp-group", "--shell", "--whitelist-environment"] };
var suCodeOptions = ["-c", "--command", "--session-command"];
var fileReaders = new Map([
  ["cat", {}],
  ["head", { valued: "nc", longValued: ["--lines", "--bytes"] }],
  ["tail", { valued: "ncbs", longValued: ["--lines", "--bytes", "--pid", "--sleep-interval", "--max-unchanged-stats"] }],
  ["less", { valued: "bhjkoOpPtTxyz" }],
  ["grep", grep],
  ["egrep", grep],
  ["fgrep", grep],
  ["rg", {
    valued: "efgtTmABCjMrEd",
    longValued: ["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--max-count", "--after-context", "--before-context", "--context", "--threads", "--max-columns", "--replace", "--encoding", "--max-depth", "--max-filesize", "--sort", "--sortr", "--pre", "--pre-glob", "--engine", "--ignore-file", "--path-separator", "--context-separator", "--field-match-separator", "--field-context-separator"],
    scriptOptions: ["-e", "-f", "--regexp", "--file"]
  }],
  ["awk", awk],
  ["gawk", awk],
  ["sed", sed],
  ["gsed", sed]
]);
var wrappers = new Map([
  ["sudo", {
    valued: "CDghpRrTtUu",
    longValued: ["--close-from", "--chdir", "--group", "--host", "--prompt", "--chroot", "--role", "--type", "--command-timeout", "--other-user", "--user"],
    stops: ["-e", "--edit", "-l", "--list", "-v", "--validate", "-V", "--version", "-K", "--remove-timestamp"],
    folderOptions: ["-D", "--chdir"],
    takesAssignments: true
  }],
  ["env", {
    valued: "aCPSu",
    longValued: ["--argv0", "--chdir", "--split-string", "--unset"],
    folderOptions: ["-C", "--chdir"],
    codeOptions: ["-S", "--split-string"],
    takesAssignments: true
  }],
  ["doas", { valued: "aCu", stops: ["-C", "-L"] }],
  ["timeout", { valued: "ks", longValued: ["--kill-after", "--signal"], leadingOperands: 1 }],
  ["flock", { valued: "wEc", longValued: ["--timeout", "--wait", "--conflict-exit-code", "--command"], codeOptions: ["-c", "--command"], leadingOperands: 1 }],
  ["stdbuf", { valued: "ioe", longValued: ["--input", "--output", "--error"] }],
  ["watch", { valued: "nq", optional: "d", longValued: ["--interval", "--equexit"], shellUnless: ["-x", "--exec"] }],
  ["nohup", {}],
  ["nice", { valued: "n", longValued: ["--adjustment"] }],
  ["time", { valued: "fo", longValued: ["--format", "--output"] }],
  ["exec", { valued: "a" }],
  ["command", { stops: ["-v", "-V"] }],
  ["xargs", {
    valued: "aEdILnPs",
    optional: "eil",
    longValued: ["--arg-file", "--delimiter", "--max-args", "--max-chars", "--max-procs", "--process-slot-var"]
  }]
]);
var inlineCodeFlags = new Map([
  ["python", ["-c"]],
  ["python2", ["-c"]],
  ["python3", ["-c"]],
  ["node", ["-e", "--eval", "-p", "--print"]],
  ["bun", ["-e", "--eval", "-p", "--print"]],
  ["deno", ["eval"]],
  ["ruby", ["-e"]],
  ["perl", ["-e", "-E"]],
  ["php", ["-r"]],
  ["lua", ["-e"]],
  ["osascript", ["-e"]]
]);
function parseShell(line) {
  const result = { commands: [], writes: [], reads: [], fetches: [], isFullyParsed: true };
  parseLine(line, "", result);
  return result;
}
function parseLine(line, folder, result) {
  if (line.includes("\x01")) {
    result.isFullyParsed = false;
    return;
  }
  try {
    const { text, markers } = scan(line, 0, false);
    walk(Dt(text, (name) => name === "" ? undefined : `$${name}`), markers, folder, result);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message.startsWith("Bad substitution: ")))
      throw error;
    result.isFullyParsed = false;
  }
}
function scan(source, start, isNested) {
  const markers = [];
  const heredocs = [];
  const mark = (marker) => `\x01${markers.push(marker) - 1}\x01`;
  let text = "";
  let depth = 0;
  let cases = 0;
  let index = start;
  let isWordStart = true;
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === `
`) {
      text += " ; ";
      index = readHeredocBodies(source, index + 1, heredocs.splice(0));
      isWordStart = true;
      continue;
    }
    if (char === " " || char === "\t") {
      text += char;
      index += 1;
      isWordStart = true;
      continue;
    }
    if (char === "#") {
      if (isWordStart)
        index = lineEnd(source, index);
      else {
        text += "\\#";
        index += 1;
      }
      continue;
    }
    if (char === "\\") {
      if (next === "")
        throw new SyntaxError("The line ends with a backslash.");
      if (next !== `
`) {
        text += char + next;
        isWordStart = false;
      }
      index += 2;
      continue;
    }
    if (char === "'" || char === "$" && next === "'") {
      const close = closingQuote(source, index + (char === "$" ? 2 : 1), "'", char === "$");
      text += source.slice(index, close + 1);
      index = close + 1;
      isWordStart = false;
      continue;
    }
    if (char === '"') {
      const quoted = readDoubleQuoted(source, index, mark);
      text += quoted.text;
      index = quoted.end;
      isWordStart = false;
      continue;
    }
    const expansion = expansionAt(source, index);
    if (expansion !== undefined) {
      text += mark(expansion);
      index = expansion.end;
      isWordStart = false;
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") {
      const close = scan(source, index + 2, true).end;
      text += mark({ raw: source.slice(index, close + 1), code: [source.slice(index + 2, close)] });
      index = close + 1;
      isWordStart = false;
      continue;
    }
    if (char === "(" && next === "(" && isWordStart) {
      const end = arithmeticEnd(source, index + 2);
      if (end !== undefined) {
        if (substitutionsIn(source.slice(index + 2, end - 2)).length > 0)
          throw new SyntaxError("An arithmetic command runs a substitution.");
        index = end;
        continue;
      }
    }
    if (source.startsWith("<<<", index)) {
      text += "<<<";
      index += 3;
      isWordStart = true;
      continue;
    }
    if (char === "<" && next === "<") {
      const heredoc = readHeredocOperator(source, index);
      heredocs.push(heredoc);
      text += ` <<< ${mark(heredoc.marker)} `;
      index = heredoc.end;
      isWordStart = true;
      continue;
    }
    if (isWordStart) {
      descriptorPattern.lastIndex = index;
      const descriptor = descriptorPattern.exec(source);
      if (descriptor !== null) {
        index += descriptor[0].length;
        continue;
      }
      if (startsWord(source, index, "case"))
        cases += 1;
      if (startsWord(source, index, "esac") && cases > 0)
        cases -= 1;
    }
    if (char === "(")
      depth += 1;
    if (char === ")") {
      if (depth > 0)
        depth -= 1;
      else if (cases === 0) {
        if (!isNested)
          throw new SyntaxError("The line closes a parenthesis it never opened.");
        if (heredocs.length > 0)
          throw new SyntaxError("A heredoc inside a substitution has no body.");
        return { text, markers, end: index };
      }
    }
    text += char;
    index += 1;
    isWordStart = separators.includes(char);
  }
  if (isNested)
    throw new SyntaxError("A substitution is never closed.");
  if (depth > 0)
    throw new SyntaxError("A parenthesis is never closed.");
  if (heredocs.length > 0)
    throw new SyntaxError("A heredoc has no body.");
  return { text, markers, end: index };
}
function readDoubleQuoted(source, start, mark) {
  let text = '"';
  let index = start + 1;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === '"')
      return { text: `${text}"`, end: index + 1 };
    if (char === "\\") {
      if (source.charAt(index + 1) !== `
`)
        text += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    const expansion = expansionAt(source, index);
    if (expansion !== undefined) {
      text += mark(expansion);
      index = expansion.end;
      continue;
    }
    text += char;
    index += 1;
  }
  throw new SyntaxError("A double quote is never closed.");
}
function expansionAt(source, index) {
  if (source.startsWith("$((", index)) {
    const end = arithmeticEnd(source, index + 3);
    if (end !== undefined)
      return { raw: source.slice(index, end), code: substitutionsIn(source.slice(index + 3, end - 2)), end };
  }
  if (source.startsWith("$(", index)) {
    const close = scan(source, index + 2, true).end;
    return { raw: source.slice(index, close + 1), code: [source.slice(index + 2, close)], end: close + 1 };
  }
  if (source.charAt(index) === "`") {
    const close = closingQuote(source, index + 1, "`", true);
    return { raw: source.slice(index, close + 1), code: [source.slice(index + 1, close).replace(/\\([\\`$])/g, "$1")], end: close + 1 };
  }
  return;
}
function substitutionsIn(text) {
  const code = [];
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) === "\\") {
      index += 2;
      continue;
    }
    const expansion = expansionAt(text, index);
    if (expansion === undefined)
      index += 1;
    else {
      code.push(...expansion.code);
      index = expansion.end;
    }
  }
  return code;
}
function arithmeticEnd(source, from) {
  let depth = 0;
  for (let index = from;index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === "(")
      depth += 1;
    if (char !== ")")
      continue;
    if (depth > 0)
      depth -= 1;
    else
      return source.charAt(index + 1) === ")" ? index + 2 : undefined;
  }
  throw new SyntaxError("An arithmetic expansion is never closed.");
}
function closingQuote(source, from, quote, isEscapable) {
  for (let index = from;index < source.length; index += 1) {
    const char = source.charAt(index);
    if (isEscapable && char === "\\")
      index += 1;
    else if (char === quote)
      return index;
  }
  throw new SyntaxError(`A ${quote} quote is never closed.`);
}
function lineEnd(source, index) {
  const end = source.indexOf(`
`, index);
  return end < 0 ? source.length : end;
}
function startsWord(source, index, word) {
  return source.startsWith(word, index) && /^$|[\s;&|()<>]/.test(source.charAt(index + word.length));
}
function readHeredocOperator(source, index) {
  let end = index + 2;
  const stripsTabs = source.charAt(end) === "-";
  if (stripsTabs)
    end += 1;
  while (source.charAt(end) === " " || source.charAt(end) === "\t")
    end += 1;
  let delimiter = "";
  let isQuoted = false;
  while (end < source.length && !/[\s;&|()<>]/.test(source.charAt(end))) {
    const char = source.charAt(end);
    if (char === "'" || char === '"') {
      const close = closingQuote(source, end + 1, char, char === '"');
      delimiter += source.slice(end + 1, close);
      isQuoted = true;
      end = close + 1;
    } else if (char === "\\") {
      delimiter += source.charAt(end + 1);
      isQuoted = true;
      end += 2;
    } else {
      delimiter += char;
      end += 1;
    }
  }
  if (delimiter === "")
    throw new SyntaxError("A heredoc has no delimiter.");
  return { delimiter, stripsTabs, isQuoted, marker: { raw: "", code: [] }, end };
}
function readHeredocBodies(source, from, heredocs) {
  let index = from;
  for (const heredoc of heredocs) {
    const lines = [];
    for (;; ) {
      if (index >= source.length)
        throw new SyntaxError(`The heredoc ${heredoc.delimiter} never ends.`);
      const end = lineEnd(source, index);
      const line = heredoc.stripsTabs ? source.slice(index, end).replace(/^\t+/, "") : source.slice(index, end);
      index = end + 1;
      if (line === heredoc.delimiter)
        break;
      lines.push(line);
    }
    heredoc.marker.raw = lines.join(`
`);
    heredoc.marker.code = heredoc.isQuoted ? [] : substitutionsIn(heredoc.marker.raw);
  }
  return index;
}
function walk(tokens, markers, start, result) {
  let folder = start;
  const subshells = [];
  let command = newCommand(undefined);
  let caseState;
  for (let index = 0;index < tokens.length; index += 1) {
    const token = tokens[index];
    if (typeof token !== "string" && "comment" in token)
      throw new SyntaxError("The line holds a comment the scanner left.");
    if (isWordToken(token)) {
      const word = wordOf(token, markers, folder, result);
      if (caseState === "header") {
        if (word.text === "in")
          caseState = "pattern";
      } else if (caseState === "pattern") {
        if (word.text === "esac")
          caseState = undefined;
      } else if (word.text === "case" && command.words.every((earlier) => reservedWords.has(earlier.text))) {
        caseState = "header";
      } else
        command.words.push(word);
      continue;
    }
    const operator = token.op;
    if (redirectOperators.has(operator)) {
      const target = tokens[index + 1];
      if (target === undefined || !isWordToken(target))
        throw new SyntaxError(`The redirection ${operator} has no target.`);
      index += 1;
      command.redirects.push({ operator, target: wordOf(target, markers, folder, result) });
      continue;
    }
    if (caseState !== undefined) {
      if (caseState === "pattern" && operator === ")")
        caseState = undefined;
      continue;
    }
    const following = tokens[index + 1];
    if (operator === "(" && command.words.length === 1 && following !== undefined && !isWordToken(following) && "op" in following && following.op === ")") {
      command = newCommand(undefined);
      index += 1;
      continue;
    }
    const before = result.commands.length;
    folder = finish(command, operator, folder, result);
    const writer = result.commands.length > before ? result.commands.length - 1 : undefined;
    command = newCommand(operator === "|" || operator === "|&" ? { writer } : undefined);
    if (operator === "(")
      subshells.push(folder);
    else if (operator === ")") {
      const outer = subshells.pop();
      if (outer === undefined)
        throw new SyntaxError("The line closes a subshell it never opened.");
      folder = outer;
    } else if (casePatternStarts.has(operator))
      caseState = "pattern";
    else if (!sequenceOperators.has(operator))
      throw new SyntaxError(`The parser does not know the operator ${operator}.`);
  }
  finish(command, ";", folder, result);
}
function newCommand(pipe) {
  return { words: [], redirects: [], pipe };
}
function isWordToken(token) {
  return typeof token === "string" || "op" in token && token.op === "glob";
}
function wordOf(token, markers, folder, result) {
  const raw = typeof token === "string" ? token : token.pattern;
  for (const match of raw.matchAll(markerPattern)) {
    for (const code of markers[Number(match[1])].code)
      parseLine(code, folder, result);
  }
  return {
    text: raw.replace(markerPattern, (_, index) => markers[Number(index)].raw),
    isGlob: typeof token !== "string",
    isDynamic: /[$\u0001]/.test(ft(raw))
  };
}
function finish(command, operator, folder, result) {
  for (const redirect of command.redirects)
    addRedirect(redirect, folder, result);
  const words = withoutPrefixes(command.words);
  const [first, ...args] = words;
  if (first === undefined || first.text === "for" || first.text === "select")
    return folder;
  const here = command.redirects.findLast((redirect) => redirect.operator === "<<<");
  const stdin = here !== undefined ? { type: "text", text: here.target.text } : command.pipe !== undefined ? { type: "pipe" } : undefined;
  const reader = result.commands.length;
  const changed = addCommand(first, args, folder, stdin, result);
  const read = result.commands[reader];
  const writer = command.pipe?.writer;
  if (read !== undefined && writer !== undefined && here === undefined)
    result.commands[reader] = { ...read, input: writer };
  const isPiped = command.pipe !== undefined || operator === "|" || operator === "|&" || operator === "&";
  return changed === undefined || isPiped ? folder : changed;
}
function withoutPrefixes(words) {
  let start = 0;
  for (;; ) {
    const text = words[start]?.text;
    if (text === undefined)
      break;
    if (text === "function")
      start += 2;
    else if (reservedWords.has(text) || assignmentPattern.test(text))
      start += 1;
    else
      break;
  }
  return words.slice(start);
}
function addRedirect({ operator, target }, folder, result) {
  if (operator === "<" || operator === "<>")
    addPath(result, "reads", target, folder);
  if (writeRedirects.has(operator) || operator === ">&" && !/^([0-9]+|-)$/.test(target.text))
    addPath(result, "writes", target, folder);
}
function addCommand(first, args, folder, stdin, result) {
  if (first.isDynamic || first.isGlob)
    result.isFullyParsed = false;
  const program = ft(first.text);
  if (program === "git")
    addGit(first, args, folder, result);
  else if (program === "find")
    addFind(first, args, folder, result);
  else if (wrappers.has(program))
    addWrapper(first, program, args, folder, stdin, result);
  else {
    const flags = expandFlags(program, args);
    const runner = result.commands.push({ argv: [first.text, ...flags], folder }) - 1;
    addEffects(program, args, flags, folder, stdin, result);
    runBy(runner, result);
    if (program === "cd")
      return changedFolder(args, folder);
  }
  return;
}
function addGit(first, args, folder, result) {
  let index = 0;
  let gitFolder = folder;
  for (let text = args[0]?.text;text?.startsWith("-") === true; text = args[index]?.text) {
    if (text === "-C")
      gitFolder = joinFolder(gitFolder, args[index + 1]?.text ?? "");
    if (text === "-c" && /^alias\.[^=]*=\s*!/i.test(args[index + 1]?.text ?? ""))
      result.isFullyParsed = false;
    index += gitValuedOptions.has(text) ? 2 : 1;
  }
  result.commands.push({ argv: [first.text, ...expandFlags("git", args.slice(index))], folder: gitFolder });
}
function addFind(first, args, folder, result) {
  const own = [];
  const actions = [];
  for (let index = 0;index < args.length; index += 1) {
    const text = args[index].text;
    if (!findActions.has(text)) {
      own.push(text);
      continue;
    }
    const end = args.findIndex((word, at) => at > index && (word.text === ";" || word.text === "+"));
    actions.push(args.slice(index + 1, end < 0 ? args.length : end));
    index = end < 0 ? args.length : end;
  }
  const runner = result.commands.push({ argv: [first.text, ...own], folder }) - 1;
  const starts = findStarts(args);
  if (own.includes("-delete"))
    for (const start of starts)
      addPath(result, "writes", start, folder);
  for (const action of actions)
    addFindAction(action, starts, folder, result);
  runBy(runner, result);
}
function addFindAction(action, starts, folder, result) {
  const [first, ...args] = action;
  if (first === undefined)
    return;
  const reads = result.reads.length;
  const writes = result.writes.length;
  addCommand(first, args, folder, undefined, result);
  if (!action.some((word) => word.text.includes("{}")))
    return;
  result.reads.splice(reads);
  result.writes.splice(writes);
  for (const start of starts) {
    const found = { commands: [], reads: result.reads, writes: result.writes, fetches: [], isFullyParsed: true };
    const [foundFirst, ...foundArgs] = action.map((word) => foundWord(word, start));
    addCommand(foundFirst, foundArgs, folder, undefined, found);
    if (!found.isFullyParsed)
      result.isFullyParsed = false;
  }
}
function foundWord(word, start) {
  if (!word.text.includes("{}"))
    return word;
  return { text: word.text.replaceAll("{}", start.text), isGlob: word.isGlob || start.isGlob, isDynamic: word.isDynamic || start.isDynamic };
}
function findStarts(args) {
  let index = 0;
  for (let text = args[0]?.text;text === "-D" || /^-([HLP]|O\d*)$/.test(text ?? ""); text = args[index]?.text)
    index += text === "-D" ? 2 : 1;
  const end = args.findIndex((word, at) => at >= index && /^[-(!),]/.test(word.text));
  const starts = args.slice(index, end < 0 ? args.length : end);
  return starts.length > 0 ? starts : [literal(".")];
}
function addWrapper(first, program, args, folder, stdin, result) {
  const wrapper = wrappers.get(program);
  if (program === "xargs" && stdin?.type !== "text")
    result.isFullyParsed = false;
  const { options, operands } = readArguments(args, wrapper, true);
  let start = args.length - operands.length;
  if (options.some((option) => wrapper.stops?.includes(option.name) === true))
    start = args.length;
  start += wrapper.leadingOperands ?? 0;
  while (wrapper.takesAssignments === true && assignmentPattern.test(args[start]?.text ?? ""))
    start += 1;
  const hasTrailingCode = wrapper.codeOptions?.includes(args[start]?.text ?? "") === true;
  const runner = result.commands.push({ argv: [first.text, ...expandFlags(program, args.slice(0, start))], folder }) - 1;
  const innerFolder = options.findLast((option) => wrapper.folderOptions?.includes(option.name) === true)?.value;
  const wrappedFolder = innerFolder === undefined ? folder : joinFolder(folder, innerFolder.text);
  const code = hasTrailingCode ? args[start + 1] : options.findLast((option) => wrapper.codeOptions?.includes(option.name) === true)?.value;
  const rest = args.slice(hasTrailingCode ? start + 2 : start);
  const isShell = wrapper.shellUnless !== undefined && !options.some((option) => wrapper.shellUnless?.includes(option.name) === true);
  const [innerFirst, ...innerArgs] = rest;
  if (code !== undefined || isShell)
    parseLine([...code === undefined ? [] : [code], ...rest].map((word) => word.text).join(" "), wrappedFolder, result);
  else if (innerFirst !== undefined)
    addCommand(innerFirst, innerArgs, wrappedFolder, stdin, result);
  runBy(runner, result);
}
function runBy(runner, result) {
  for (const command of result.commands.slice(runner + 1))
    command.runner ??= runner;
}
function addEffects(program, args, flags, folder, stdin, result) {
  const fileProgram = fileReaders.get(program);
  const fileWriter = fileWriters.get(program);
  const copyProgram = copyPrograms.get(program);
  const fetcher = fetchers.get(program);
  const inlineFlags = inlineCodeFlags.get(program);
  if (program === "eval")
    result.isFullyParsed = false;
  else if (shells.has(program))
    addShell(args, folder, stdin, result);
  else if (program === "ssh")
    addSsh(args, stdin, result);
  else if (program === "su")
    addSu(args, folder, result);
  else if (program === "source" || program === ".")
    addPath(result, "reads", readArguments(args, {}, true).operands[0], folder);
  else if (program === "dd")
    for (const word of args.filter((arg) => arg.text.startsWith("of=")))
      addPath(result, "writes", { ...word, text: word.text.slice(3) }, folder);
  else if (fileWriter !== undefined)
    for (const operand of readArguments(args, fileWriter, false).operands)
      addPath(result, "writes", operand, folder);
  else if (copyProgram !== undefined)
    addCopy(copyProgram, args, folder, result);
  else if (fileProgram !== undefined)
    addFileArguments(fileProgram, args, folder, result);
  else if (fetcher !== undefined)
    addFetches(fetcher, args, result);
  else if (inlineFlags !== undefined) {
    if (program === "perl" && readArguments(args, perl, false).options.some((option) => option.name === "-i"))
      addFileArguments(perl, args, folder, result);
    const script = args.find((word) => !word.text.startsWith("-") || word.text === "-");
    const readsCodeFromPipe = stdin?.type === "pipe" && (script === undefined || script.text === "-");
    if (flags.some((flag) => inlineFlags.includes(flag)) || stdin?.type === "text" || readsCodeFromPipe)
      result.isFullyParsed = false;
  }
}
function addShell(args, folder, stdin, result) {
  const { options, operands } = readArguments(args, { valued: "oO", longValued: ["--rcfile", "--init-file"] }, true);
  const script = operands[0];
  if (options.some((option) => option.name === "-c")) {
    if (script !== undefined)
      parseLine(script.text, folder, result);
  } else if (script === undefined || options.some((option) => option.name === "-s"))
    addStdinCode(stdin, folder, result);
}
function addSsh(args, stdin, result) {
  const { operands } = readArguments(args, { valued: "BbcDEeFIiJLlmOoPpQRSWw" }, true);
  const remote = operands.slice(1);
  if (remote.length > 0)
    parseLine(remote.map((word) => word.text).join(" "), "~", result);
  else if (operands.length > 0)
    addStdinCode(stdin, "~", result);
}
function addSu(args, folder, result) {
  const code = readArguments(args, su, false).options.findLast((option) => suCodeOptions.includes(option.name))?.value;
  if (code !== undefined)
    parseLine(code.text, folder, result);
}
function addFetches(fetcher, args, result) {
  const { options, operands } = readArguments(args, fetcher, false);
  const urls = [...options.filter((option) => option.name === "--url").flatMap((option) => option.value === undefined ? [] : [option.value]), ...operands];
  for (const url of urls)
    result.fetches.push(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.text) ? url.text : `http://${url.text}`);
}
function addStdinCode(stdin, folder, result) {
  if (stdin?.type === "text")
    parseLine(stdin.text, folder, result);
  if (stdin?.type === "pipe")
    result.isFullyParsed = false;
}
function addCopy(program, args, folder, result) {
  const { options, operands } = readArguments(args, program, false);
  const target = options.findLast((option) => program.targetOptions?.includes(option.name) === true)?.value;
  const only = operands[0];
  if (program.linksHere === true && target === undefined && operands.length === 1 && only !== undefined) {
    addPath(result, "writes", { ...only, text: ft(only.text) }, folder);
    return;
  }
  const destination = target ?? operands.at(-1);
  const sources = target === undefined ? operands.slice(0, -1) : operands;
  if (destination === undefined || sources.length === 0)
    return;
  const isLocal = (word) => program.skipsRemote !== true || !/^[^/]*:/.test(word.text);
  for (const source of sources.filter(isLocal)) {
    if (program.sources !== undefined)
      addPath(result, program.sources, source, folder);
    if (isLocal(destination) && !source.isGlob && !destination.isGlob)
      addPathText(result, "writes", `${destination.text.replace(/\/+$/, "")}/${ft(source.text)}`, folder);
  }
  if (isLocal(destination))
    addPath(result, "writes", destination, folder);
}
function addFileArguments(program, args, folder, result) {
  const { options, operands } = readArguments(args, program, false);
  const inPlace = options.find((option) => program.inPlaceOptions?.includes(option.name) === true && (program !== awk || option.value?.text === "inplace"));
  let files = operands;
  if (program === sed && inPlace !== undefined && inPlace.value === undefined) {
    const suffix = files[0]?.text;
    const hasScriptOption = options.some((option) => program.scriptOptions?.includes(option.name) === true);
    if (suffix === "" || !hasScriptOption && suffix !== undefined && /^\.[\w.-]*$/.test(suffix))
      files = files.slice(1);
  }
  if (program.scriptOptions !== undefined && !options.some((option) => program.scriptOptions?.includes(option.name) === true))
    files = files.slice(1);
  if (program.takesAssignments === true)
    files = files.filter((file) => !assignmentPattern.test(file.text));
  for (const file of files)
    addPath(result, inPlace === undefined ? "reads" : "writes", file, folder);
}
function readArguments(args, spec, stopsAtOperand) {
  const options = [];
  const operands = [];
  for (let index = 0;index < args.length; index += 1) {
    const word = args[index];
    const text = word.text;
    if (text === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (word.isGlob || text === "-" || !text.startsWith("-")) {
      if (stopsAtOperand) {
        operands.push(...args.slice(index));
        break;
      }
      operands.push(word);
      continue;
    }
    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      if (equals >= 0)
        options.push({ name: text.slice(0, equals), value: literal(text.slice(equals + 1)) });
      else if (spec.longValued?.includes(text) === true) {
        options.push({ name: text, value: args[index + 1] });
        index += 1;
      } else
        options.push({ name: text, value: undefined });
      continue;
    }
    for (let at = 1;at < text.length; at += 1) {
      const letter = text.charAt(at);
      const rest = text.slice(at + 1);
      if (spec.optional?.includes(letter) === true) {
        options.push({ name: `-${letter}`, value: rest === "" ? undefined : literal(rest) });
        break;
      }
      if (spec.valued?.includes(letter) === true) {
        if (rest !== "")
          options.push({ name: `-${letter}`, value: literal(rest) });
        else {
          options.push({ name: `-${letter}`, value: args[index + 1] });
          index += 1;
        }
        break;
      }
      options.push({ name: `-${letter}`, value: undefined });
    }
  }
  return { options, operands };
}
function expandFlags(program, args) {
  const texts = args.map((word) => word.text);
  if (nonGetoptPrograms.has(program))
    return texts;
  const spec = fileReaders.get(program) ?? wrappers.get(program);
  const takesValue = `${spec?.valued ?? ""}${spec?.optional ?? ""}`;
  const end = texts.indexOf("--");
  return texts.flatMap((text, index) => end >= 0 && index > end || !clusterPattern.test(text) ? [text] : expandCluster(text, takesValue));
}
function expandCluster(cluster, takesValue) {
  const flags = [];
  for (let index = 1;index < cluster.length; index += 1) {
    const letter = cluster.charAt(index);
    if (takesValue.includes(letter) && index < cluster.length - 1)
      return [...flags, `-${cluster.slice(index)}`];
    flags.push(`-${letter}`);
  }
  return flags;
}
function changedFolder(args, folder) {
  const target = args.find((word) => !word.text.startsWith("-") || word.text === "-");
  if (target === undefined)
    return "~";
  return joinFolder(folder, target.text === "-" ? "$OLDPWD" : target.text);
}
function addPath(result, access, word, folder) {
  if (word !== undefined && !word.isGlob)
    addPathText(result, access, word.text, folder);
}
function addPathText(result, access, path, folder) {
  if (path === "" || path.startsWith("/dev/"))
    return;
  const joined = joinFolder(folder, path);
  if (dynamicPattern.test(joined.replace(homePrefix2, "")))
    result.isFullyParsed = false;
  result[access].push(joined);
}
function joinFolder(folder, path) {
  return folder === "" || /^(\/|~|\$HOME(\/|$))/.test(path) ? path : `${folder}/${path}`;
}
function literal(text) {
  return { text, isGlob: false, isDynamic: false };
}

// node_modules/@cmodjs/core/utils/call-effects.js
function callEffects(use, workspace) {
  const { fs } = workspace;
  const absolute = (path, folder = workspace.cwd) => ve(folder, expandHome(path, workspace.home, workspace.configRoot));
  const access = (path) => ({ path: absolute(path), contents: undefined });
  const effects = { shell: undefined, reads: [], writes: [], urls: [], subagent: undefined };
  if (use.tool === "Bash") {
    const line = textField(use, "command");
    const parsed = parseShell(line);
    const commands = parsed.commands.map(({ argv, folder }) => ({ argv, folder: absolute(folder) }));
    effects.shell = { line, commands, isFullyParsed: parsed.isFullyParsed };
    effects.reads = parsed.reads.map(access);
    effects.writes = parsed.writes.map(access);
    effects.urls = parsed.fetches;
  } else if (use.tool === "PowerShell") {
    effects.shell = { line: textField(use, "command"), commands: [], isFullyParsed: false };
  } else if (use.tool === "Edit") {
    const path = absolute(textField(use, "file_path"));
    effects.writes = [{ path, contents: once(() => editedContents(use, path, fs)) }];
  } else if (use.tool === "Write") {
    const path = absolute(textField(use, "file_path"));
    const content = textField(use, "content");
    effects.writes = [{ path, contents: once(async () => contentsOf(content, await previousContentOf(path, fs))) }];
  } else if (use.tool === "NotebookEdit") {
    const path = absolute(textField(use, "notebook_path"));
    effects.writes = [{ path, contents: once(async () => contentsOf(undefined, await previousContentOf(path, fs))) }];
  } else if (use.tool === "Read") {
    effects.reads = [access(textField(use, "file_path"))];
  } else if (use.tool === "Grep") {
    effects.reads = [access(optionalTextField(use, "path") ?? "")];
  } else if (use.tool === "Glob") {
    const folder = absolute(optionalTextField(use, "path") ?? "");
    effects.reads = [{ path: absolute(textField(use, "pattern"), folder), contents: undefined }];
  } else if (use.tool === "WebFetch") {
    effects.urls = [textField(use, "url")];
  } else if (use.tool === "Agent") {
    effects.subagent = optionalTextField(use, "subagent_type") ?? "general-purpose";
  }
  return effects;
}
async function editedContents(use, path, fs) {
  const previousContent = await previousContentOf(path, fs);
  const oldString = textField(use, "old_string");
  const newString = textField(use, "new_string");
  if (oldString === "")
    return contentsOf(previousContent === undefined || previousContent === "" ? newString : undefined, previousContent);
  if (previousContent === undefined || !previousContent.includes(oldString))
    return contentsOf(undefined, previousContent);
  const content = fieldOf(use, "replace_all") === true ? previousContent.split(oldString).join(newString) : previousContent.replace(oldString, () => newString);
  return contentsOf(content, previousContent);
}
async function previousContentOf(path, fs) {
  const stat = await fs.stat(path).catch(ifMissing(undefined));
  return stat?.kind === "file" ? fs.read(path) : undefined;
}
function contentsOf(content, previousContent) {
  return { ...content === undefined ? {} : { content }, ...previousContent === undefined ? {} : { previousContent } };
}
function once(load) {
  let loaded;
  return () => loaded ??= load();
}
function fieldOf(use, name) {
  return use.input[name];
}

class InvalidCall extends Error {
}
function textField(use, name) {
  const value = fieldOf(use, name);
  if (typeof value !== "string")
    throw new InvalidCall(`The ${use.tool} call has no text field ${name}.`);
  return value;
}
function optionalTextField(use, name) {
  return fieldOf(use, name) === undefined ? undefined : textField(use, name);
}

// node_modules/@cmodjs/core/runtime/hooks.js
function classicHook(event, hook, report) {
  const routed = async (e, next) => {
    const ours = await Promise.resolve().then(() => hook(e, next.signal)).catch((error) => {
      report({ id: `hook:${event}`, message: `The ${event} listener failed`, error });
      return;
    });
    if (ours === undefined)
      return next(e);
    return mergeClassic(await next(e), ours);
  };
  return routed;
}
function classicFailure(failed) {
  const routed = async (e, error, next) => {
    const ours = await failed(e, error);
    return ours === undefined ? undefined : mergeClassic(await next(e), ours);
  };
  return routed;
}
var frontmatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
var baseDirectoryLine = /^Base directory for this skill: [^\n]*\n\n/;
function userSkillHook(claude) {
  return async (e, next) => {
    const { name, root } = claude.plugin;
    if (!e.skill.startsWith(`${name}:`))
      return next(e);
    const skill = e.skill.slice(name.length + 1);
    const skills = `${root}/skills`;
    if (!await claude.fs.exists(skills) || !(await claude.fs.list(skills)).some((entry) => entry.name === skill))
      return next(e);
    if ((await claude.fs.stat(`${skills}/${skill}`)).kind !== "dir")
      return next(e);
    const env = { HOME: await claude.env.home(), CLAUDE_CONFIG_DIR: await claude.env.configHome() };
    for (const { folder } of configFolders(env, name, await claude.session.root()).toReversed()) {
      const path = `${folder}/skills/${skill}/SKILL.md`;
      if (await claude.fs.exists(path))
        return { text: `${baseDirectoryLine.exec(e.text)?.[0] ?? ""}${(await claude.fs.read(path)).replace(frontmatter, "")}` };
    }
    return next(e);
  };
}
async function callFiles(name, claude, folders, use, cwd) {
  try {
    const { home, configRoot } = await folders;
    if (home === undefined)
      throw new Error("HOME is not set, so ~ in a path has no meaning.");
    const { shell, reads, writes } = callEffects(use, { cwd, home, ...configRoot === undefined ? {} : { configRoot }, fs: claude.fs });
    const known = (accesses) => accesses.map(({ path }) => path).filter((path) => shell === undefined || !dynamicPattern.test(path));
    const unchecked = (path) => (error) => {
      if (!isMissing(error))
        claude.ui.warn("call:files", `${name}: the ${use.tool} call reads ${path}, which could not be checked: ${messageOf(error)}`);
      return;
    };
    const read = await Promise.all(known(reads).map(async (path) => (await claude.fs.stat(path).catch(unchecked(path)))?.kind === "file" ? [path] : []));
    return { read: read.flat(), changed: known(writes) };
  } catch (error) {
    if (!(error instanceof InvalidCall))
      claude.ui.warn("call:files", `${name}: the ${use.tool} call lists no files: ${messageOf(error)}`);
    return { read: [], changed: [] };
  }
}
function mergeClassic(below, ours) {
  const merged = { ...below, ...ours };
  const context = [...below["additionalContext"] ?? [], ...ours["additionalContext"] ?? []];
  if (context.length > 0)
    merged["additionalContext"] = context;
  return merged;
}

// node_modules/@cmodjs/core/runtime/sessions.js
var conversationMethods = {
  sessions: "cmod:sessions",
  session: "cmod:session",
  search: "cmod:search",
  messages: "cmod:messages",
  turns: "cmod:turns",
  contexts: "cmod:contexts",
  tasks: "cmod:tasks",
  goal: "cmod:goal",
  updateGoal: "cmod:updateGoal",
  subscribe: "cmod:subscribe",
  watchBefore: "cmod:watchBefore",
  act: "cmod:act",
  changed: "cmod:changed",
  before: "cmod:before",
  sessionColor: "cmod:sessionColor"
};
function subagentTranscript(sessionTranscript, task) {
  return sessionTranscript?.endsWith(".jsonl") === true ? `${sessionTranscript.slice(0, -".jsonl".length)}/subagents/agent-${task}.jsonl` : undefined;
}
var sessionFields = { id: true, title: true, color: true, project: true, cwd: true, transcriptPath: true, model: true, startedAt: true, lastAt: true, forkedFrom: true, isRunning: true, agentType: true, visitedAt: true, device: true, status: true, waitingFor: true, contextPercent: true, lastTurn: true };
async function usageOf(claude) {
  const [model, usage] = await Promise.all([claude.session.model(), claude.session.usage()]);
  const { tokens, window, percent } = usage.context;
  const rateLimits = usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ type: kind, percent: percentUsed, ...resetsAt === undefined ? {} : { resetsAt } }));
  return { model, contextWindow: { ...tokens === undefined ? {} : { tokenCount: tokens }, size: window, ...percent === undefined ? {} : { percent } }, rateLimits, ...usage.cost === undefined ? {} : { cost: { usd: usage.cost.usd } } };
}
function payloadOf(change) {
  if (change.type === Message)
    return change.message;
  if ("turn" in change)
    return change.turn;
  if ("context" in change)
    return change.context;
  if ("task" in change) {
    const { id, title, agentType, model, openedBy, openedAt, closedAt, isBackground, forkedFrom } = change.task;
    const owner = { id, title, ...agentType === undefined ? {} : { agentType }, ...model === undefined ? {} : { model }, ...forkedFrom === undefined ? {} : { forkedFrom }, startedAt: openedAt };
    return { id, title, openedBy, openedAt, ...closedAt === undefined ? {} : { closedAt }, ...isBackground === true ? { isBackground } : {}, owner };
  }
  if ("usage" in change)
    return change.usage;
  return change.goal;
}
function isHeardBy(event, matcher, change) {
  const named = change.type === Message ? event === Message || event === change.message.type : event === change.type;
  return named && (matcher === undefined || matches(payloadOf(change), matcher));
}
function taskOfChange(change) {
  if (change.type === Message)
    return change.message.task;
  if (change.type === TaskStart || change.type === TaskEnd)
    return change.task.id === "" ? change.task.parent : change.task.id;
  if (change.type === TurnStart || change.type === TurnEnd)
    return change.turn.prompt.task;
  if (change.type === ContextStart || change.type === ContextEnd)
    return change.context.task;
  if (change.type === GoalChange)
    return change.goal.task;
  return;
}
function ownerOfChange(change) {
  if (change.type === TaskStart || change.type === TaskEnd)
    return change.task.parent;
  return taskOfChange(change);
}
function contextOfChange(change) {
  if (change.type === Message)
    return change.message.context;
  if (change.type === TurnStart || change.type === TurnEnd)
    return change.turn.context;
  if (change.type === ContextStart || change.type === ContextEnd)
    return change.context.number;
  if (change.type === TaskStart || change.type === TaskEnd)
    return change.task.context;
  return;
}
function isInScope(scope, session, change, isUnder) {
  if (scope.session !== undefined && scope.session !== session)
    return false;
  const task = taskOfChange(change);
  if (scope.isAgent === true)
    return (change.type === TaskStart || change.type === TaskEnd ? change.task.parent : task) === scope.task;
  if (scope.task !== undefined && (task === undefined || !isUnder(task, scope.task)))
    return false;
  if (scope.context !== undefined && (contextOfChange(change) !== scope.context || ownerOfChange(change) !== scope.task))
    return false;
  if (scope.turn === undefined)
    return true;
  if (change.type === Message)
    return change.message.turn === scope.turn;
  return (change.type === TurnStart || change.type === TurnEnd) && change.turn.prompt.id === scope.turn;
}
function withoutPermissionCheck(name, hearer) {
  return `${name}: ${hearer} hears Claude Code's permission check, so hooks/register.ts must call registerPermissionCheck(addHook) after registerMod.`;
}
function createSessionsClient({ name, claude, report, hookOn, routeOn, permissionRoutes }) {
  const call = (method, input) => claude.cmod.call({ to: cmodPluginName, method, input });
  const listening = new Map;
  const deciding = new Map;
  const queued = new Set;
  const parents = new Map;
  const readingParents = new Map;
  const known = new Map;
  let current = { id: "", title: "", project: "", cwd: "", model: "", startedAt: "", lastAt: "", isRunning: true };
  let told = { session: "" };
  const ownOnly = (method) => new Error(`${name}: ${method} works only in a mod's own session.`);
  const colored = ({ color: _color, ...data }) => told.session === data.id && told.color !== undefined ? { ...data, color: told.color } : data;
  const keyOf = (scope) => scope.session ?? current.id;
  const subscribe = (key) => {
    if (queued.has(key))
      return;
    queued.add(key);
    Promise.resolve().then(async () => {
      queued.delete(key);
      const heard = (from) => [...from.get(key) ?? []].map(({ event, matcher, options, scope }) => ({ event, matcher: matcher === undefined ? undefined : sentMatcher(matcher), scope, ...options.onFailure === "refuse" ? { onFailure: "refuse" } : {}, ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs } }));
      const tracksTasks = [...listening.get(key) ?? [], ...deciding.get(key) ?? []].some(({ scope }) => scope.task !== undefined || scope.isGoal === true);
      const subscriptions = [...heard(listening), ...tracksTasks ? [{ event: TaskStart }] : []];
      await call(conversationMethods.subscribe, { session: key, subscriptions }).catch((error) => report(`sessions:${key}`, `Hears nothing from session ${key}`, error));
      await call(conversationMethods.watchBefore, { session: key, subscriptions: heard(deciding) }).catch((error) => report(`before:${key}`, `Changes nothing in session ${key}`, error));
    });
  };
  const parentsOf = (session) => {
    const known = parents.get(session);
    if (known !== undefined)
      return known;
    const reading = readingParents.get(session);
    if (reading !== undefined)
      return reading;
    const read = call(conversationMethods.tasks, { session, all: true }).then((tasks) => {
      const tree = new Map(tasks.map((task) => [task.id, task.parent]));
      parents.set(session, tree);
      return tree;
    }).finally(() => readingParents.delete(session));
    readingParents.set(session, read);
    return read;
  };
  const isUnderIn = (tree) => (task, ancestor) => {
    for (let at = task, steps = 0;at !== undefined && steps < 64; at = tree?.get(at), steps += 1)
      if (at === ancestor)
        return true;
    return false;
  };
  const inScope = ({ scope }, session, change) => {
    if (scope.task === undefined || scope.isAgent === true)
      return isInScope(scope, session, change, isUnderIn(undefined));
    const tree = parentsOf(session);
    if (tree instanceof Map)
      return isInScope(scope, session, change, isUnderIn(tree));
    return tree.then((read) => isInScope(scope, session, change, isUnderIn(read)), (error) => {
      report(`tasks:${session}`, "Could not read the tasks it listens under", error);
      return false;
    });
  };
  const remember = (session, change) => {
    if (change.type !== TaskStart)
      return;
    parents.get(session)?.set(change.task.id, change.task.parent);
    readingParents.get(session)?.then((tree) => tree.set(change.task.id, change.task.parent), (error) => claude.ui.warn("tasks:read", `${name}: the tasks of ${session} stay unread until the next change: ${messageOf(error)}`));
  };
  const add = (into, scope, event, method, args, onChange) => {
    const key = keyOf(scope);
    const entry = { scope, event, method, ...listenerOf(name, method, args) };
    const set = into.get(key) ?? new Set;
    set.add(entry);
    into.set(key, set);
    onChange(key);
    return {
      remove() {
        for (const [at, held] of into) {
          if (!held.delete(entry))
            continue;
          if (held.size === 0)
            into.delete(at);
          onChange(at);
          return;
        }
      }
    };
  };
  const refusalOf = (options, takes, error) => options.onFailure === "refuse" && takes.includes("refuse") ? { refuse: `${name}: ${messageOf(error)}` } : undefined;
  const invoke = (method, options, cancel, run, takes = []) => withinTime(claude.clock, method, options, cancel, run).catch((error) => {
    if (cancel.aborted || error instanceof PassedTimeout && !method.startsWith("before"))
      return;
    report(`session:${method}`, `The ${method} listener failed`, error);
    return refusalOf(options, takes, error);
  });
  const decidersOf = (session, event) => [...deciding.get(session) ?? []].filter((entry) => entry.event === event);
  const decides = async (entry, session, change) => (entry.matcher === undefined || matches(payloadOf(change), entry.matcher)) && await inScope(entry, session, change);
  const combined = async (session, event, change, cancel) => {
    const askers = decidersOf(session, event).map((entry) => async (latest) => {
      if (!await decides(entry, session, latest))
        return;
      const payload = await payloadFor(session, latest);
      return invoke(entry.method, entry.options, cancel, async (time) => takenAnswer(entry.method, beforeAnswerKeys[event], await entry.listener(payload, time)), beforeAnswerKeys[event]);
    });
    const answer = await foldBefore(event, change, askers, (error) => report(`session:${methodOf("before", event)}`, `The ${methodOf("before", event)} listener failed`, error));
    return answer?.note === undefined ? answer : { ...answer, note: modNote(name, answer.note) };
  };
  const eventMethods = (scopeOf, hasBefore, ended) => {
    const method = (into, named, event) => (...args) => {
      if (ended !== undefined)
        throw new Error(`${name}: ${ended} has ended, so its ${named} never fires. Listen on its Session.`);
      const scope = scopeOf();
      if (routeOn === undefined || keyOf(scope) !== current.id)
        throw ownOnly(named);
      return add(into, scope, event, named, args, subscribe);
    };
    return Object.fromEntries([
      ...Object.entries(sessionEvents).map(([named, event]) => [`on${named}`, method(listening, `on${named}`, event)]),
      ...hasBefore ? beforeEvents.map((named) => [`before${named}`, method(deciding, `before${named}`, sessionEvents[named])]) : []
    ]);
  };
  let folders;
  const withFiles = async (message) => {
    if (message.type !== ToolCall && message.type !== ToolResult)
      return message;
    folders ??= Promise.all([claude.env.home(), claude.env.configHome()]).then(([home, configRoot]) => ({ home, configRoot }));
    return { ...message, files: await callFiles(name, claude, folders, { tool: message.name, input: message.input }, message.cwd) };
  };
  const messagesFrom = async (method, input) => Promise.all((await call(method, input)).map(withFiles));
  const searched = (request, matcher) => ({
    async* [Symbol.asyncIterator]() {
      let before = request["before"];
      for (;; ) {
        const page = await messagesFrom(conversationMethods.search, { ...request, ...before === undefined ? {} : { before } });
        for (const message of page)
          if (matcher === undefined || matches(message, matcher))
            yield message;
        const last = page.at(-1);
        if (last === undefined || page.length < searchLimit)
          return;
        before = { session: last.session, id: last.id };
      }
    }
  });
  const recordPart = (scope, ended) => ({
    search: (text, matcher) => searched({ text, ...scope }, matcher),
    ...eventMethods(() => scope, true, ended)
  });
  const turnOf = (scope, data) => {
    const task = data.prompt.task ?? scope.task;
    return {
      ...data,
      ...recordPart({ ...scope, ...task === undefined ? {} : { task }, turn: data.prompt.id }, data.closedAt === undefined ? undefined : `turn ${data.prompt.id}`),
      messages: () => messagesFrom(conversationMethods.messages, { session: scope.session, turn: data.prompt.id, ...task === undefined ? {} : { task } }),
      abort: async () => {
        if (data.closedAt !== undefined)
          throw new Error(`${name}: turn ${data.prompt.id} has ended, so there is nothing to abort.`);
        const session = scope.session ?? current.id;
        await act(session, "abort", { turn: data.prompt.id }, task === undefined ? undefined : { session, task });
      }
    };
  };
  const contextOf = (scope, data) => {
    const owned = { ...scope.session === undefined ? {} : { session: scope.session }, ...data.task === undefined ? {} : { task: data.task } };
    return {
      ...data,
      ...recordPart({ ...owned, context: data.number }, data.closedAt === undefined ? undefined : `context ${data.number}`),
      turns: async () => (await call(conversationMethods.turns, { ...owned, context: data.number })).map((turn) => turnOf(owned, turn))
    };
  };
  const taskOf = (session, data) => {
    const record = data.isBackground === true ? { session: data.id } : { session, task: data.id };
    return {
      id: data.id,
      title: data.title,
      openedBy: data.openedBy,
      openedAt: data.openedAt,
      ...data.closedAt === undefined ? {} : { closedAt: data.closedAt },
      ...data.status === undefined ? {} : { status: data.status },
      ...data.name === undefined ? {} : { name: data.name },
      ...data.spawnedBy === undefined ? {} : { spawnedBy: data.spawnedBy },
      ...data.isBackground === true ? { isBackground: true } : {},
      owner: ownerOf(session, data),
      ...recordPart({ session, task: data.id }),
      search: (text, matcher) => searched({ text, ...record }, matcher),
      tasks: async () => (await call(conversationMethods.tasks, record)).map((task) => taskOf(record.session, task)),
      messages: () => messagesFrom(conversationMethods.messages, record)
    };
  };
  const goalOf = (where) => ({
    search: (text, matcher) => searched({ text, ...where() }, matcher),
    ...eventMethods(() => ({ ...where(), isGoal: true }), true),
    text: async () => (await call(conversationMethods.goal, where())).text,
    tasks: async () => {
      const { session = current.id, task } = where();
      return (await call(conversationMethods.tasks, { session, ...task === undefined ? {} : { task } })).map((each) => taskOf(session, each));
    },
    update: async ({ text }) => {
      if (text.trim() === "")
        throw new Error(`${name}: a goal needs text.`);
      const { session = current.id, task } = where();
      await call(conversationMethods.updateGoal, { session, ...task === undefined ? {} : { task }, text });
    }
  });
  const payloadFor = async (session, change) => {
    const scope = { session };
    if (change.type === Message)
      return withFiles(change.message);
    if ("turn" in change)
      return turnOf(scope, change.turn);
    if ("context" in change)
      return contextOf(scope, change.context);
    if ("task" in change)
      return taskOf(session, change.task);
    if ("usage" in change)
      return change.usage;
    const { task } = change.goal;
    return goalOf(() => ({ session, ...task === undefined ? {} : { task } }));
  };
  const act = (session, action, input, owned) => call(conversationMethods.act, { session: owned?.session ?? session, action, input, ...owned === undefined ? {} : { task: owned.task } });
  const sendHere = async ({ type, text, as }) => {
    if (type === Note) {
      if (as !== undefined)
        throw new Error(`${name}: a Note is always from this mod, so it takes no as.`);
      const added = await claude.session.append({ message: { type: "user", content: [{ type: "text", text: modNote(name, text) }] } });
      if (added.deny !== undefined)
        throw new Error(`${name}: Claude Code refused the note: ${added.deny}`);
      return;
    }
    const submitted = await claude.prompt.submit({ text, ...as === Person ? { asUser: true } : {} });
    if ("drop" in submitted && typeof submitted.drop === "string")
      throw new Error(`${name}: Claude Code dropped the prompt: ${submitted.drop}`);
  };
  const surfacesHere = async () => [...await claude.session.surfaces()];
  const sessionOf = (read, owned, isOwner = owned !== undefined, hears = true) => {
    const id = () => read().id;
    const isHere = () => owned === undefined && id() === current.id;
    const scope = () => owned === undefined ? { session: id(), isAgent: true } : { session: owned.session, task: owned.task, isAgent: true };
    const where = () => owned === undefined ? { session: id() } : { session: owned.session, task: owned.task };
    const turnsOf = async (options = {}) => (await call(conversationMethods.turns, { ...where(), ...options })).map((turn) => turnOf(where(), turn));
    const contextsOf = async () => (await call(conversationMethods.contexts, where())).map((context) => contextOf(where(), context));
    const data = Object.defineProperties({}, Object.fromEntries(Object.keys(sessionFields).map((key) => [key, { get: () => read()[key], enumerable: true, configurable: true }])));
    const session = Object.assign(data, {
      search: (text, matcher) => recordPart(scope()).search(text, matcher),
      ...hears ? eventMethods(scope, true) : {},
      goal: goalOf(where),
      context: async () => {
        const all = await contextsOf();
        const last = all.at(-1);
        if (last === undefined)
          throw new Error(`${name}: session ${id()} has no context yet.`);
        return last;
      },
      contexts: contextsOf,
      turn: async () => {
        const [last] = await turnsOf({ last: 1 });
        return last?.closedAt === undefined ? last : undefined;
      },
      turns: turnsOf,
      messages: (options = {}) => messagesFrom(conversationMethods.messages, { ...where(), ...options }),
      usage: async () => isHere() ? usageOf(claude) : act(id(), "usage", null, owned),
      surfaces: async () => isHere() ? surfacesHere() : act(id(), "surfaces", null, owned),
      async send(message) {
        if (message.text.trim() === "")
          throw new Error(`${name}: send needs text.`);
        if (isHere() && message.as !== Session)
          return sendHere(message);
        await act(id(), "send", message, owned);
      },
      async end() {
        await act(id(), "end", null, owned);
      },
      async visit(at) {
        await act(id(), "visit", at ?? new Date().toISOString(), owned);
      }
    });
    if (isOwner)
      return session;
    const started = async (starting) => taskOf(id(), await starting.catch((error) => Promise.reject(new Error(`${name}: ${messageOf(error)}`))));
    return Object.assign(session, {
      startTask: (task) => started(task.isBackground === true || task.device !== undefined ? act(id(), "startBackgroundTask", task) : isHere() ? spawnTask(claude, task) : act(id(), "startTask", task)),
      fork: (task) => started(isHere() && task.isBackground !== true && task.at === undefined ? spawnTask(claude, task, current.id) : act(id(), "fork", task)),
      delete: async () => {
        await act(id(), "delete", null);
      },
      callTool: async (toolCall) => await withFiles(await act(id(), "callTool", toolCall))
    });
  };
  const ownerOf = (session, data) => {
    const parent = session === current.id ? current : known.get(session);
    const isBackground = data.isBackground === true;
    const transcriptPath = isBackground ? known.get(data.id)?.transcriptPath : subagentTranscript(parent?.transcriptPath, data.id);
    return sessionOf(() => ({
      id: data.id,
      title: data.title,
      project: parent?.project ?? "",
      ...data.agentType === undefined ? {} : { agentType: data.agentType },
      model: data.model ?? "",
      cwd: parent?.cwd ?? "",
      ...transcriptPath === undefined ? {} : { transcriptPath },
      isRunning: data.closedAt === undefined && (isBackground || (parent?.isRunning ?? true)),
      startedAt: data.openedAt,
      lastAt: data.closedAt ?? data.openedAt,
      ...data.forkedFrom === undefined ? {} : { forkedFrom: data.forkedFrom }
    }), isBackground ? undefined : { session, task: data.id }, true);
  };
  const processListeners = new Map;
  const processHearers = (method, payload) => [...processListeners.get(method) ?? []].filter(({ matcher, isEveryAgent }) => (payload["task"] === undefined || isEveryAgent) && (matcher === undefined || matches(payload, matcher)));
  const raise = async (method, payload, cancel) => {
    const heard = processHearers(method, payload);
    if (!method.startsWith("before")) {
      await Promise.all(heard.map(({ listener, options }) => invoke(method, options, cancel, (time) => listener(payload, time))));
      return;
    }
    const takes = takesOf(method);
    const askers = heard.map(({ listener, options }) => () => invoke(method, options, cancel, async (time) => takenAnswer(method, takes, await listener(payload, time)), takes));
    return foldAnswers(method, takes, ["refuse"], undefined, askers, (error) => report(`session:${method}`, `The ${method} listener failed`, error));
  };
  const takesOf = (method) => answerKeys[method.slice("before".length)] ?? [];
  const refusalFor = (method, payload, error) => processHearers(method, payload).map((entry) => refusalOf(entry.options, takesOf(method), error)).find((answer) => answer !== undefined);
  const commandRun = async (e) => {
    const source = (await claude.command.list()).find((command) => command.name === e.command)?.source;
    return { session: current.id, cwd: current.cwd, name: e.command, args: e.args, ...defined({ source }), from: senderOf(e.origin, false) };
  };
  const commandListeners = { beforeRun: new Set, onRun: new Set };
  for (const [method, held] of Object.entries(commandListeners))
    processListeners.set(method, held);
  routeOn?.("command.run", async (e, next) => {
    if (commandListeners.beforeRun.size === 0 && commandListeners.onRun.size === 0)
      return next(e);
    const run = await commandRun(e);
    const answer = commandListeners.beforeRun.size === 0 ? undefined : await raise("beforeRun", run, next.signal);
    if (typeof answer?.["refuse"] === "string")
      return { text: answer["refuse"] };
    if (typeof answer?.["result"] === "string")
      return { text: answer["result"], ...typeof answer["exitCode"] === "number" ? { exitCode: answer["exitCode"] } : {} };
    const args = typeof answer?.["args"] === "string" ? answer["args"] : e.args;
    const ran = await next(args === e.args ? e : { ...e, args });
    raise("onRun", { ...run, args }, next.signal);
    return typeof answer?.["note"] === "string" ? { ...ran, context: [...ran.context ?? [], modNote(name, answer["note"])] } : ran;
  }, async (e, error) => {
    const refusal = commandListeners.beforeRun.size === 0 ? undefined : refusalFor("beforeRun", await commandRun(e), error);
    return refusal === undefined ? undefined : { text: refusal.refuse };
  });
  const listenTo = (method, named) => {
    if (hookOn === undefined || routeOn === undefined)
      throw ownOnly(method);
    const isBefore = method.startsWith("before");
    if (named === "PermissionCheck" || named === "PermissionRequest") {
      const routes = permissionRoutes?.();
      if (routes === undefined)
        throw new Error(withoutPermissionCheck(name, method));
      return routes(method, { name, raise, refusalFor, hookOn, routeOn, current: () => current });
    }
    const event = processEvents[named];
    const hook = (isBefore ? event.before : undefined) ?? event.on;
    if (method === "beforeSessionStart")
      routeOn("session.compact", trackCompaction);
    if (method === "beforeModelChange")
      hookOn(event.on, () => {
        const notes = modelNotes.splice(0);
        return notes.length === 0 ? undefined : { additionalContext: notes };
      });
    const failed = (input, error) => {
      const refusal = refusalFor(method, processPayloadOf(named, input), error);
      return refusal === undefined ? undefined : hookAnswerOf(name, named, refusal);
    };
    return hookOn(hook, async (input, signal) => {
      const payload = processPayloadOf(named, input);
      if (named === "SessionStart" && payload["source"] === "compact") {
        if (!isBefore)
          return;
        const task = compacting?.agentId;
        const model = task === undefined ? await claude.session.model() : undefined;
        const answer = await raise(method, { ...payload, ...defined({ task, model, title: current.title || undefined }) }, signal);
        if (answer === undefined)
          return;
        return hookAnswerOf(name, named, task === undefined ? answer : defined({ note: answer["note"] }));
      }
      if (!isBefore) {
        raise(method, payload, signal);
        return;
      }
      if (named === "ModelChange")
        modelNotes.splice(0);
      const answer = await raise(method, payload, signal);
      if (answer === undefined)
        return;
      if (named === "ModelChange" && typeof answer["note"] === "string" && answer["refuse"] === undefined)
        modelNotes.push(modNote(name, answer["note"]));
      return hookAnswerOf(name, named, answer);
    }, isBefore ? failed : undefined);
  };
  const modelNotes = [];
  let compacting;
  const trackCompaction = async (e, next) => {
    compacting = e;
    try {
      return await next(e);
    } finally {
      if (compacting === e)
        compacting = undefined;
    }
  };
  const listen = (method, args, isEveryAgent = false) => {
    const heard = listenerOf(name, method, args);
    const entry = { ...heard, options: method === "beforePermissionRequest" ? { ...heard.options, onFailure: "refuse" } : heard.options, isEveryAgent };
    const held = processListeners.get(method) ?? new Set;
    if (!processListeners.has(method)) {
      listenTo(method, method.replace(/^(on|before)/, ""));
      processListeners.set(method, held);
    }
    held.add(entry);
    return { remove: () => void held.delete(entry) };
  };
  const processMethods = () => Object.fromEntries(Object.entries(processEvents).flatMap(([named, event]) => [`on${named}`, ..."before" in event ? [`before${named}`] : []]).map((method) => [method, (...args) => listen(method, args)]));
  const here = sessionOf(() => current);
  const currentSession = Object.assign(here, processMethods(), {
    goal: Object.assign(here.goal, { beforeSessionStart: (...args) => listen("beforeSessionStart", args, true) }),
    async scrollTo(message, options) {
      const { deny } = await claude.ui.scroll({ to: { requestId: message.id }, ...options?.block === undefined ? {} : { block: options.block } });
      if (deny !== undefined)
        throw new Error(`${name}: Claude Code did not scroll to the message: ${deny}`);
    },
    caption: (toolCall, text) => claude.ui.notice(toolCall.callId, text)
  });
  const failedBefore = (session, event, change, error) => {
    const asked = decidersOf(session, event).filter((entry) => isInScope(entry.scope, session, change, isUnderIn(parents.get(session))) && (entry.matcher === undefined || matches(payloadOf(change), entry.matcher)));
    return asked.map((entry) => refusalOf(entry.options, beforeAnswerKeys[event], error)).find((answer) => answer !== undefined);
  };
  const listed = (data) => {
    if (data.id !== current.id) {
      known.set(data.id, data);
      return sessionOf(() => known.get(data.id) ?? data, undefined, false, false);
    }
    current = { ...current, title: current.title || data.title, device: data.device };
    return currentSession;
  };
  return {
    sessions: {
      get current() {
        return currentSession;
      },
      list: async (scope = {}) => (await call(conversationMethods.sessions, scope)).map(listed),
      get: async (id) => id === current.id ? currentSession : listed(await call(conversationMethods.session, { session: id })),
      search: (text, matcher, options = {}) => searched({ text, ...searchOptionsOf(options) }, matcher)
    },
    changed(session, change, cancel) {
      remember(session, change);
      let payload;
      for (const entry of listening.get(session) ?? []) {
        const { event, method, matcher, listener, options } = entry;
        const deliver = () => {
          payload ??= payloadFor(session, change);
          payload.then((heard) => invoke(method, options, cancel, (time) => listener(heard, time))).catch((error) => report(`session:${method}`, `The ${method} listener failed`, error));
        };
        const isHeard = isHeardBy(event, matcher, change) && inScope(entry, session, change);
        if (isHeard === true)
          deliver();
        else if (isHeard !== false)
          isHeard.then((isIn) => isIn && deliver());
      }
    },
    answerBefore: combined,
    failedBefore,
    raise,
    listen,
    turn: (data) => turnOf({ session: current.id }, data),
    follow(next) {
      const moved = next.id !== current.id && current.id !== "";
      const previous = current.id;
      current = colored({ device: current.device, ...next, title: next.title || (next.id === current.id ? current.title : ""), isRunning: true, lastAt: new Date().toISOString() });
      if (!moved)
        return;
      for (const into of [listening, deciding]) {
        const kept = into.get(previous);
        if (kept === undefined)
          continue;
        into.delete(previous);
        for (const entry of kept)
          if (entry.scope.session === previous)
            entry.scope = { ...entry.scope, session: current.id };
        into.set(current.id, new Set([...into.get(current.id) ?? [], ...kept]));
      }
      parents.delete(previous);
      subscribe(previous);
      subscribe(current.id);
    },
    recolor(next) {
      told = next;
      current = colored(current);
    }
  };
}
var recordOf = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
var defined = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
var placementOf = (input) => defined({ session: input["session_id"], task: input["agent_id"], agentType: input["agent_type"], cwd: input["cwd"], permissionMode: input["permission_mode"] });
var mcpServerOf = (server) => server === undefined ? undefined : { name: String(recordOf(server)["name"]), source: String(recordOf(server)["source"]) };
var modelChangeOf = (input) => ({
  model: input["to_model"],
  previous: input["from_model"],
  requested: input["requested_model"] ?? undefined,
  source: input["source"],
  contextTokenCount: input["context_tokens"],
  isCacheWarm: input["prompt_cache_warm"],
  cacheTtl: input["cache_ttl"],
  cacheWriteUsd: input["estimated_cache_write_usd"],
  pricing: input["pricing"]
});
var answerKeys = {
  Run: ["args", "note", "result", "exitCode", "refuse"],
  ProjectSetup: ["note"],
  SessionStart: ["note", "title", "reloadSkills", "firstPrompt"],
  ModelChange: ["ask", "refuse", "note"],
  WorktreeCreate: ["result"],
  Elicitation: ["refuse"],
  ElicitationResponse: ["refuse"],
  PermissionCheck: ["allow", "ask", "refuse", "note"],
  PermissionRequest: ["allow", "input", "updates", "refuse", "interrupt"],
  PermissionDenial: ["retry"],
  ToolBatch: ["note"],
  TodoCreate: ["refuse"],
  TodoComplete: ["refuse"],
  ReplyDisplay: ["text"]
};
var todoOf = (input) => ({ id: input["task_id"], subject: input["task_subject"], description: input["task_description"], teammate: input["teammate_name"] });
var processFields = {
  ProjectSetup: (input) => ({ trigger: input["trigger"] }),
  SessionStart: (input) => ({
    source: input["source"],
    model: input["model"],
    title: input["session_title"] || undefined,
    idleSeconds: input["seconds_since_last_response"],
    contextTokenCount: input["context_tokens"],
    isCacheWarm: input["prompt_cache_likely_expired"] === undefined ? undefined : input["prompt_cache_likely_expired"] !== true,
    cacheWriteUsd: input["estimated_cache_write_usd"]
  }),
  SessionEnd: (input) => ({ reason: input["reason"] === "prompt_input_exit" ? "exit" : input["reason"] }),
  ModelChange: modelChangeOf,
  CwdChange: (input) => ({ cwd: input["new_cwd"] ?? input["cwd"], previous: input["old_cwd"] }),
  DirectoryAdd: (input) => ({ directory: input["directory"], source: input["source"] === "slash_command" ? "command" : "sdk" }),
  WorktreeCreate: (input) => ({ name: input["name"] }),
  WorktreeRemove: (input) => ({ path: input["worktree_path"] }),
  Notification: (input) => ({ text: input["message"], title: input["title"], type: input["notification_type"] }),
  Elicitation: (input) => ({ id: input["elicitation_id"], server: input["mcp_server_name"], text: input["message"], mode: input["mode"], url: input["url"], schema: input["requested_schema"] }),
  ElicitationResponse: (input) => ({ id: input["elicitation_id"], server: input["mcp_server_name"], mode: input["mode"], action: input["action"], content: input["content"] }),
  PermissionRequest: (input) => ({ name: input["tool_name"], input: recordOf(input["tool_input"]), suggestions: input["permission_suggestions"] ?? [], mcpServer: mcpServerOf(input["mcp_server"]) }),
  PermissionDenial: (input) => ({ name: input["tool_name"], input: recordOf(input["tool_input"]), callId: input["tool_use_id"], reason: input["reason"], mcpServer: mcpServerOf(input["mcp_server"]) }),
  ToolBatch: (input) => ({
    calls: (Array.isArray(input["tool_calls"]) ? input["tool_calls"] : []).map((call) => {
      const fields = recordOf(call);
      return defined({ callId: fields["tool_use_id"], name: fields["tool_name"], input: recordOf(fields["tool_input"]), output: fields["tool_response"] });
    })
  }),
  TodoCreate: todoOf,
  TodoComplete: todoOf,
  ReplyDisplay: (input) => ({ replyId: input["message_id"], index: input["index"], isLast: input["final"], text: input["delta"] })
};
async function spawnTask(claude, task, forkedFrom) {
  if (task.title.trim() === "")
    throw new Error("a task needs a title.");
  const { name, agentType, model, cwd } = forkedFrom === undefined ? task : { prompt: task.prompt, title: task.title, agentType: forkAgentType };
  const started = await claude.agent.spawn({
    prompt: task.prompt,
    description: task.title,
    ...name === undefined ? {} : { name },
    ...agentType === undefined ? {} : { subagentType: agentType },
    ...model === undefined ? {} : { model },
    ...cwd === undefined ? {} : { cwd }
  });
  if (started.deny !== undefined)
    throw new Error(`Claude Code refused the task: ${started.deny}`);
  if (started.agentId === undefined)
    throw new Error("Claude Code answered without starting a task.");
  return { id: started.agentId, title: task.title, ...forkedFrom === undefined ? { agentType: agentType ?? "general-purpose" } : { forkedFrom }, model: started.model, openedBy: "", openedAt: new Date().toISOString() };
}
function processPayloadOf(named, input) {
  const fields = recordOf(input);
  return { ...placementOf(fields), ...defined(processFields[named](fields)) };
}
function hookAnswerOf(name, named, answer) {
  const refuse = typeof answer["refuse"] === "string" ? answer["refuse"] : undefined;
  const note = typeof answer["note"] === "string" ? [modNote(name, answer["note"])] : undefined;
  if (named === "SessionStart")
    return defined({ additionalContext: note, sessionTitle: answer["title"], reloadSkills: answer["reloadSkills"] === true ? true : undefined, initialUserMessage: answer["firstPrompt"] });
  if (named === "ModelChange") {
    if (refuse !== undefined)
      return { permissionDecision: "deny", permissionDecisionReason: refuse };
    return typeof answer["ask"] === "string" ? { permissionDecision: "ask", permissionDecisionReason: answer["ask"] } : undefined;
  }
  if (named === "ProjectSetup")
    return defined({ additionalContext: note });
  if (named === "WorktreeCreate")
    return defined({ worktreePath: answer["result"] });
  if (named === "PermissionDenial")
    return answer["retry"] === true ? { retry: true } : undefined;
  if (named === "ToolBatch")
    return defined({ additionalContext: note });
  if (named === "ReplyDisplay")
    return defined({ displayContent: answer["text"] });
  return refuse === undefined ? undefined : { block: refuse };
}
function searchOptionsOf({ running, since, everyProject, before }) {
  return {
    ...running === undefined ? {} : { running },
    ...since === undefined ? {} : { since },
    ...everyProject === undefined ? {} : { everyProject },
    ...before === undefined ? {} : { before: { session: before.session, id: before.id } }
  };
}

// node_modules/@cmodjs/core/runtime/conversations.js
var relayKinds = new Set(["act", "goal", "taskEnd"]);

// node_modules/@cmodjs/core/runtime/announce.js
var announcementMs = 1e4;
async function announcementOf(claude, plugin, added, openSettings) {
  const manifest = jsonOf(await claude.fs.read(`${plugin.root}/.claude-plugin/plugin.json`).catch(ifMissing(undefined)));
  const { program, hotkeys } = plugin.steps;
  const rules = (await claude.fs.list(`${plugin.root}/rules`).catch(ifMissing([]))).filter((entry) => entry.kind === "file" && entry.name.endsWith(".md")).map((entry) => entry.name.slice(0, -".md".length)).toSorted();
  const lines = [
    isObject(manifest) && typeof manifest["description"] === "string" ? manifest["description"] : undefined,
    added.length > 0 ? `Adds ${listed(added)}.` : undefined,
    rules.length > 0 ? `Adds ${rules.length} ${rules.length === 1 ? "rule" : "rules"}: ${listed(rules)}.` : undefined,
    program === undefined ? undefined : `Installed the ${program} program.`,
    ...Object.values(hotkeys ?? {}).flatMap(({ title, default: combo }) => combo === undefined ? [] : [`Binds ${combo} to ${title}.`])
  ].filter((line) => line !== undefined);
  return { message: "Installed", ...lines.length === 0 ? {} : { description: lines.join(`
`) }, action: { label: "Settings", onClick: () => openSettings() } };
}
function jsonOf(text) {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      return;
    throw error;
  }
}

// node_modules/@cmodjs/core/runtime/bound.js
var current;
function bind(imports) {
  current = imports;
}
function bound() {
  if (current === undefined)
    throw new Error("A mod's imports work once its setup runs. Call them from setup or from a hook, never at the top of a module.");
  return current;
}

// node_modules/@cmodjs/core/runtime/engine.js
var engines = new WeakMap;
function keepEngine(mod, engine) {
  engines.set(mod, engine);
}
function engineOf(mod) {
  const engine = engines.get(mod);
  if (engine === undefined)
    throw new Error("This mod has not started, so it reaches no Claude Code calls yet.");
  return engine;
}

// node_modules/@cmodjs/core/utils/metadata.js
class MetadataError extends Error {
  line;
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}
var markdown = ["md", "markdown", "mdx"];
var hashComments = ["sh", "bash", "zsh", "fish", "py", "rb", "pl", "r", "yaml", "yml", "toml", "ps1", "nu", "tcl", "mk", "conf", "cfg", "env"];
var slashComments = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "rs", "swift", "kt", "kts", "java", "c", "h", "cc", "cpp", "hpp", "cs", "scala", "dart", "zig", "jsonc", "json5"];
var dashComments = ["lua", "sql", "hs", "elm"];
var hashCommentNames = ["Makefile", "Dockerfile", "Brewfile", "Gemfile", "Rakefile", "Justfile", "justfile"];
var sidecarSuffix = ".meta";
function formatOf(path, firstLine) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (markdown.includes(extension))
    return { type: "frontmatter" };
  if (hashComments.includes(extension) || hashCommentNames.includes(name))
    return { type: "comment", prefix: "#" };
  if (slashComments.includes(extension))
    return { type: "comment", prefix: "//" };
  if (dashComments.includes(extension))
    return { type: "comment", prefix: "--" };
  if (extension === "" && firstLine?.startsWith("#!") === true)
    return { type: "comment", prefix: "#" };
  return { type: "sidecar" };
}
function readMetadata(text, format) {
  const lines = text.split(`
`);
  if (format.type === "comment") {
    const region = commentRegion(lines, format.prefix);
    return { metadata: region === undefined ? {} : asRecord(mapEntries(region.lines, region.start + 2, 0)) };
  }
  const region = format.type === "frontmatter" ? frontmatterRegion(lines) : { start: -1, end: lines.length, lines };
  if (region === undefined)
    return { metadata: {} };
  const block = metadataBlock(region);
  const name = format.type === "frontmatter" ? topLevelScalar(region, "name") : undefined;
  return { metadata: block === undefined ? {} : asRecord(block.entries), ...name === undefined ? {} : { name } };
}
function writeMetadata(text, format, metadata) {
  const lines = text.split(`
`);
  const entries = Object.entries(metadata);
  if (format.type === "comment") {
    const { prefix } = format;
    const block = entries.length === 0 ? [] : [`${prefix} /// metadata`, ...entries.map(([key, value]) => `${prefix} ${scalar(key)}: ${scalar(value)}`), `${prefix} ///`];
    const region = commentRegion(lines, prefix);
    if (region !== undefined)
      return [...lines.slice(0, region.start), ...block, ...lines.slice(region.end + 1)].join(`
`);
    if (block.length === 0)
      return text;
    const at = lines[0]?.startsWith("#!") === true ? 1 : 0;
    return [...lines.slice(0, at), ...block, ...lines.slice(at)].join(`
`);
  }
  const map = entries.length === 0 ? [] : ["metadata:", ...entries.map(([key, value]) => `  ${scalar(key)}: ${scalar(value)}`)];
  if (format.type === "sidecar") {
    const block = metadataBlock({ start: -1, end: lines.length, lines });
    const rest = block === undefined ? lines : [...lines.slice(0, block.start), ...lines.slice(block.end)];
    const kept = rest.join(`
`).trim();
    return [...kept === "" ? [] : [kept], ...map].join(`
`) + (map.length === 0 && kept === "" ? "" : `
`);
  }
  const region = frontmatterRegion(lines);
  if (region === undefined)
    return map.length === 0 ? text : ["---", ...map, "---", ...lines].join(`
`);
  const block = metadataBlock(region);
  const inner = block === undefined ? [...region.lines, ...map] : [...lines.slice(region.start + 1, block.start), ...map, ...lines.slice(block.end, region.end)];
  if (inner.every((line) => line.trim() === ""))
    return lines.slice(region.end + 1).join(`
`);
  return [...lines.slice(0, region.start + 1), ...inner, ...lines.slice(region.end)].join(`
`);
}
function frontmatterRegion(lines) {
  if (lines[0]?.replace(/^\uFEFF/, "").trimEnd() !== "---")
    return;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1)
    throw new MetadataError(1, "the frontmatter starts with --- and never ends. Close it with a --- line.");
  return { start: 0, end, lines: lines.slice(1, end) };
}
function commentRegion(lines, prefix) {
  const start = lines.findIndex((line) => line.trimEnd() === `${prefix} /// metadata`);
  if (start === -1)
    return;
  const content = [];
  for (let index = start + 1;index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trimEnd();
    if (line === `${prefix} ///`)
      return { start, end: index, lines: content };
    if (line !== prefix && !line.startsWith(`${prefix} `))
      break;
    content.push(line.slice(prefix.length + 1));
  }
  throw new MetadataError(start + 1, `the metadata block never ends. Close it with a "${prefix} ///" line.`);
}
function metadataBlock(region) {
  const at = region.lines.findIndex((line) => /^metadata\s*:/.test(line));
  if (at === -1)
    return;
  const lineNumber = region.start + 2 + at;
  const rest = withoutComment((region.lines[at] ?? "").replace(/^metadata\s*:/, "")).trim();
  const start = region.start + 1 + at;
  if (rest.startsWith("{"))
    return { start, end: start + 1, entries: flowEntries(rest, lineNumber) };
  if (rest !== "")
    throw new MetadataError(lineNumber, "metadata holds a single value. Write a map of names to text, such as metadata: { mymod.key: value }.");
  let index = at + 1;
  while (index < region.lines.length && (/^\s/.test(region.lines[index] ?? "") || (region.lines[index] ?? "").trim() === ""))
    index += 1;
  while (index > at + 1 && (region.lines[index - 1] ?? "").trim() === "")
    index -= 1;
  const children = region.lines.slice(at + 1, index);
  return { start, end: region.start + 1 + index, entries: mapEntries(children, lineNumber + 1, indentOf(children)) };
}
function indentOf(lines) {
  const first = lines.find((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  return first === undefined ? 0 : /^\s*/.exec(first)?.[0].length ?? 0;
}
function mapEntries(lines, firstLine, indent) {
  const entries = [];
  lines.forEach((raw, index) => {
    const lineNumber = firstLine + index;
    const line = withoutComment(raw);
    if (line.trim() === "")
      return;
    const depth = /^\s*/.exec(line)?.[0].length ?? 0;
    if (depth !== indent)
      throw new MetadataError(lineNumber, "a metadata value holds a list or a map. Each value is one line of text, and a list is one space-separated text.");
    const body = line.trim();
    if (body.startsWith("- "))
      throw new MetadataError(lineNumber, "metadata holds a list. Write a map of names to text, and a list as one space-separated text.");
    entries.push(entryOf(body, lineNumber));
  });
  return entries;
}
function flowEntries(text, lineNumber) {
  if (!text.endsWith("}"))
    throw new MetadataError(lineNumber, "the metadata map starts with { and does not end on the same line. Close it with }, or write one entry per line.");
  const body = text.slice(1, -1).trim();
  if (body === "")
    return [];
  return splitOutsideQuotes(body, ",", lineNumber).map((part) => part.trim()).filter((part) => part !== "").map((part) => entryOf(part, lineNumber));
}
function entryOf(text, lineNumber) {
  const [keyText, ...rest] = splitOutsideQuotes(text, ":", lineNumber, true);
  if (keyText === undefined || rest.length === 0)
    throw new MetadataError(lineNumber, `"${text}" has no ":". Write each entry as name: value.`);
  const valueText = rest.join(":").trim();
  if (valueText.startsWith("{") || valueText.startsWith("[") || valueText === "|" || valueText === ">")
    throw new MetadataError(lineNumber, `${keyText.trim()} holds a list or a map. Each value is one line of text, and a list is one space-separated text.`);
  return { key: unquoted(keyText.trim(), lineNumber), value: unquoted(valueText, lineNumber) };
}
function splitOutsideQuotes(text, separator, lineNumber, needsSpace = false) {
  const parts = [];
  let quote;
  let current = "";
  for (let index = 0;index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += text[index + 1] ?? "";
        index += 1;
      } else if (char === quote)
        quote = undefined;
      continue;
    }
    const before = current.trimEnd().at(-1);
    if ((char === '"' || char === "'") && (before === undefined || before === ":"))
      quote = char;
    const next = text[index + 1];
    if (char === separator && (!needsSpace || next === undefined || next === " " || next === "\t")) {
      parts.push(current);
      current = "";
      if (needsSpace) {
        parts.push(text.slice(index + 1));
        return parts;
      }
      continue;
    }
    current += char;
  }
  if (quote !== undefined)
    throw new MetadataError(lineNumber, `a ${quote === '"' ? "double" : "single"} quote never closes.`);
  parts.push(current);
  return parts;
}
function withoutComment(line) {
  let quote;
  for (let index = 0;index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === "\\" && quote === '"')
        index += 1;
      else if (char === quote)
        quote = undefined;
      continue;
    }
    if (char === '"' || char === "'")
      quote = char;
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? "")))
      return line.slice(0, index);
  }
  return line;
}
function unquoted(text, lineNumber) {
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2)
      throw new MetadataError(lineNumber, `${text} opens a double quote that never closes.`);
    try {
      return JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError))
        throw error;
      throw new MetadataError(lineNumber, `${text} is not a double-quoted text. Escape a " inside it as \\".`);
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2)
      throw new MetadataError(lineNumber, `${text} opens a single quote that never closes.`);
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}
function topLevelScalar(region, key) {
  const at = region.lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at === -1)
    return;
  const text = withoutComment((region.lines[at] ?? "").slice(key.length + 1)).trim();
  if (text === "")
    return;
  try {
    return unquoted(text, region.start + 2 + at);
  } catch (error) {
    if (error instanceof MetadataError)
      return;
    throw error;
  }
}
function asRecord(entries) {
  return Object.freeze(Object.fromEntries(entries.map(({ key, value }) => [key, value])));
}
var plain = /^[A-Za-z0-9_./+~$%^()=\\][^#]*$/;
var special = /^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?|0x[0-9a-fA-F]+|\.inf|\.nan)$/i;
function scalar(text) {
  const isPlain = plain.test(text) && text === text.trim() && !text.includes(": ") && !text.endsWith(":") && !text.includes(" #") && !special.test(text) && !/["',{}[\]]/.test(text);
  return isPlain ? text : JSON.stringify(text);
}

// node_modules/@cmodjs/core/runtime/metadata.js
var skippedFolders = [".git", "node_modules"];
var ownKey = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
function resolvedPath(path, places) {
  const configured = /^~\/\.claude(?=\/|$)/.exec(path);
  if (configured !== null && places.configRoot !== undefined)
    return ve(`${places.configRoot}${path.slice(configured[0].length)}`);
  const prefix = homePrefix.exec(path)?.[0];
  if (prefix !== undefined) {
    if (places.home === undefined)
      throw new Error(`${path} starts with ${prefix}, and HOME is not set. Start Claude Code with HOME set.`);
    return ve(expandHome(path, places.home, places.configRoot));
  }
  return path.startsWith("/") ? ve(path) : ve(places.projectRoot(), path);
}
function createModFiles({ name, claude, places, report }) {
  const prefix = `${name}.`;
  const cache = new Map;
  const logged = new Set;
  const own = (all) => Object.freeze(Object.fromEntries(Object.entries(all).flatMap(([key, value]) => key.startsWith(prefix) ? [[key.slice(prefix.length), value]] : [])));
  const locate = async (path) => {
    const stat = await claude.fs.stat(path, { resolve: true });
    if (stat.kind !== "file")
      throw new Error(`${path} is not a file, so it holds no metadata.`);
    const realPath = stat.realPath ?? path;
    const extensionless = !realPath.slice(realPath.lastIndexOf("/") + 1).includes(".");
    const firstLine = extensionless ? (await claude.fs.read(realPath)).split(`
`, 1)[0] : undefined;
    const format = formatOf(realPath, firstLine);
    const holder = format.type === "sidecar" ? `${realPath}${sidecarSuffix}` : realPath;
    const sidecar = format.type === "sidecar" ? await claude.fs.stat(holder).catch(ifMissing(undefined)) : undefined;
    return { realPath, format, holder, signature: `${stat.mtimeMs}:${stat.size}:${sidecar?.kind === "file" ? `${sidecar.mtimeMs}:${sidecar.size}` : ""}` };
  };
  const textOf = async (holder) => (await claude.fs.stat(holder).catch(ifMissing(undefined)))?.kind === "file" ? claude.fs.read(holder) : "";
  const skipped = (path, value) => (error) => {
    if (isMissing(error))
      return value;
    const reason = `${name}: fs.find skipped ${path}: ${messageOf(error)}`;
    if (!logged.has(reason))
      claude.ui.warn("fs:find", reason);
    logged.add(reason);
    return value;
  };
  const readEntry = async (path) => {
    const located = await locate(path);
    const cached = cache.get(path);
    if (cached?.signature === located.signature)
      return cached.read;
    let read;
    try {
      const { metadata, name: declared } = readMetadata(await textOf(located.holder), located.format);
      read = { metadata, ...declared === undefined ? {} : { name: declared } };
    } catch (error) {
      if (!(error instanceof MetadataError))
        throw error;
      const failure = `${located.holder} ${error.message}`;
      read = { metadata: {}, error: failure };
      if (!logged.has(failure))
        report({ id: `metadata:${located.holder}`, message: `Skips the metadata of ${located.holder}`, description: failure });
      logged.add(failure);
    }
    cache.set(path, { signature: located.signature, read });
    return read;
  };
  const matchesOf = async (pattern) => {
    const absolute = resolvedPath(pattern, places);
    const scanned = $s.scan(absolute);
    if (!scanned.isGlob)
      return (await claude.fs.stat(absolute).catch(skipped(absolute, undefined)))?.kind === "file" ? [absolute] : [];
    const isMatch = $s(absolute, { dot: true });
    const entersSkipped = skippedFolders.filter((folder) => scanned.glob.split("/").includes(folder));
    const maxDepth = scanned.glob.includes("**") ? Number.POSITIVE_INFINITY : scanned.glob.split("/").length;
    const found = [];
    const visited = new Set;
    const walk = async (folder, depth) => {
      const real = (await claude.fs.stat(folder, { resolve: true }).catch(skipped(folder, undefined)))?.realPath ?? folder;
      if (visited.has(real))
        return;
      visited.add(real);
      const entries = await claude.fs.list(folder).catch(skipped(folder, []));
      await Promise.all(entries.map(async (entry) => {
        const path = `${folder}/${entry.name}`;
        const kind = entry.isLink === true ? (await claude.fs.stat(path).catch(skipped(path, undefined)))?.kind : entry.kind;
        if (kind === "file" && isMatch(path))
          found.push(path);
        if (kind !== "dir" || depth + 1 >= maxDepth)
          return;
        if (skippedFolders.includes(entry.name) && !entersSkipped.includes(entry.name))
          return;
        await walk(path, depth + 1);
      }));
    };
    const base = scanned.base === "" ? "/" : scanned.base;
    if ((await claude.fs.stat(base).catch(skipped(base, undefined)))?.kind === "dir")
      await walk(base, 0);
    return found;
  };
  return {
    async find(glob) {
      const patterns = typeof glob === "string" ? [glob] : glob;
      const paths = [...new Set((await Promise.all(patterns.map(matchesOf))).flat())].sort();
      const kept = paths.filter((path) => !(path.endsWith(sidecarSuffix) && paths.includes(path.slice(0, -sidecarSuffix.length))));
      return Promise.all(kept.map(async (path) => {
        const read = await readEntry(path).catch((error) => ({ metadata: {}, error: `${path} ${messageOf(error)}` }));
        return { path, ...read.name === undefined ? {} : { name: read.name }, metadata: own(read.metadata), ...read.error === undefined ? {} : { error: read.error } };
      }));
    },
    async read(path) {
      const read = await readEntry(resolvedPath(path, places));
      if (read.error !== undefined)
        throw new Error(`${name}: ${read.error}`);
      return own(read.metadata);
    },
    async update(path, change) {
      const given = resolvedPath(path, places);
      const located = await locate(given);
      const text = await textOf(located.holder);
      let all;
      try {
        all = readMetadata(text, located.format).metadata;
      } catch (error) {
        throw new Error(`${name}: ${located.holder} ${messageOf(error)}`, { cause: error });
      }
      const edited = { ...own(all) };
      change(edited);
      for (const [key, value] of Object.entries(edited)) {
        if (!ownKey.test(key))
          throw new Error(`${name}: the metadata key "${key}" is not a name. Use letters, digits, "_", ".", and "-".`);
        if (typeof value !== "string")
          throw new Error(`${name}: the metadata key "${key}" holds ${JSON.stringify(value)}. Each value is text, and a list is one space-separated text.`);
        if (value.includes(`
`))
          throw new Error(`${name}: the metadata key "${key}" holds a line break. Each value is one line of text.`);
      }
      const next = {};
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(prefix))
          next[key] = value;
        else if (Object.hasOwn(edited, key.slice(prefix.length)))
          next[key] = edited[key.slice(prefix.length)];
      }
      for (const [key, value] of Object.entries(edited))
        next[`${prefix}${key}`] = value;
      if (JSON.stringify(next) === JSON.stringify(all))
        return;
      await claude.fs.write(located.holder, writeMetadata(text, located.format, next));
      cache.delete(given);
    }
  };
}

// node_modules/@cmodjs/core/options.js
var optionKey = /^[A-Za-z_]\w*$/;
function checkOptions(name, options) {
  for (const [key, declared] of Object.entries(options)) {
    const at = `${name}: options.${key}`;
    if (!optionKey.test(key))
      throw new Error(`${at} is not an option name. Use letters, digits, and _, starting with a letter, as Claude Code passes each option on as CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}.`);
    if (declared.title.trim() === "")
      throw new Error(`${at} needs a title, the label /config shows.`);
    if (declared.type === "choice" && (declared.choices ?? []).length === 0)
      throw new Error(`${at} is a choice with no choices. Give option.choice(['a', 'b'], { ... }).`);
    if (declared.type === "choice" && declared.default !== undefined && !(declared.choices ?? []).includes(declared.default))
      throw new Error(`${at} defaults to ${String(declared.default)}, which is not one of its choices: ${(declared.choices ?? []).join(", ")}.`);
  }
  return options;
}
function projectOptionsOf(name, declared, text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch (error) {
    return { values: {}, ignored: [`is not JSON (${messageOf(error)}). Fix the file; ${name} uses its other options until then.`] };
  }
  if (!isObject(file))
    return { values: {}, ignored: ['is not a JSON object. Write one, such as { "branch": "main" }.'] };
  const values = {};
  const ignored = [];
  for (const [key, value] of Object.entries(file)) {
    const option = declared[key];
    if (option === undefined)
      ignored.push(`sets ${key}, which ${name} does not declare. ${Object.keys(declared).length === 0 ? "Remove it." : `Remove it, or use one of: ${Object.keys(declared).join(", ")}.`}`);
    else if (option.type === "secret")
      ignored.push(`sets ${key}, a secret, and a project file is committed for everyone to read. Remove it. ${secretFix}`);
    else {
      const misfit = fitsOption(option, value);
      if (misfit === undefined)
        values[key] = value;
      else
        ignored.push(`sets ${key} to ${JSON.stringify(value)}, and ${option.title} ${misfit}.`);
    }
  }
  return { values, ignored };
}
function isUnset(value) {
  return value === undefined || value === "" || Array.isArray(value) && value.length === 0;
}
function fitsOption(declared, value) {
  const type = declared.type;
  if (type === "toggle")
    return typeof value === "boolean" ? undefined : "takes true or false";
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return "takes a number";
    if (declared.min !== undefined && value < declared.min)
      return `takes ${declared.min} or more`;
    if (declared.max !== undefined && value > declared.max)
      return `takes ${declared.max} or less`;
    return;
  }
  if (type === "list")
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? undefined : "takes a list of text";
  if (typeof value !== "string")
    return "takes text";
  if (type === "choice" && !(declared.choices ?? []).includes(value))
    return `takes one of: ${(declared.choices ?? []).join(", ")}`;
  return;
}

// node_modules/@cmodjs/core/ui/elements.js
var tableFacts = new WeakMap;
var plainTerminal = { hasNerdFont: false };
function drawnIn() {
  return drawing?.drawnIn ?? plainTerminal;
}
var unbuilt = Symbol("an element built outside a render");
var drawing;
var lowerings = new Map;
function hostComponent(name, canonical, lower) {
  lowerings.set(name, lower);
  return (props) => elementNamed(name, canonical(props));
}
function elementNamed(name, props) {
  return drawing === undefined ? { [unbuilt]: { name, props } } : build(drawing, name, props);
}
function drawWith(table, draw, markdown) {
  const outer = drawing;
  const current = { table, markdown, drawnIn: tableFacts.get(table) ?? plainTerminal };
  drawing = current;
  try {
    return built(current, draw());
  } finally {
    drawing = outer;
  }
}
function element(name) {
  return (props) => elementNamed(name, props);
}
function build(current, name, props) {
  const lower = lowerings.get(name);
  if (lower !== undefined)
    return lower(props);
  const ready = "children" in props ? { ...props, children: built(current, props.children) } : props;
  if (name === "Markdown" && current.markdown !== undefined)
    return current.markdown(ready);
  return current.table[name](ready);
}
function built(current, value) {
  if (Array.isArray(value))
    return value.map((child) => built(current, child));
  if (typeof value !== "object" || value === null || !(unbuilt in value))
    return value;
  const { name, props } = value[unbuilt];
  return build(current, name, props);
}
function drawKeyed(keyPrefix, draw) {
  const outer = drawing;
  drawing = undefined;
  try {
    return keyed(draw(), keyPrefix);
  } finally {
    drawing = outer;
  }
}
function keyed(value, keyPrefix) {
  if (Array.isArray(value))
    return value.map((each) => keyed(each, keyPrefix));
  if (typeof value !== "object" || value === null || !(unbuilt in value))
    return value;
  const { name, props } = value[unbuilt];
  const prefixed = Object.fromEntries(Object.entries(props).map(([field, each]) => [field, field === "key" && typeof each === "string" ? `${keyPrefix}${each}` : keyed(each, keyPrefix)]));
  return { [unbuilt]: { name, props: prefixed } };
}
var elementKey = "$cmodElement";
var handlerKey = "$cmodHandler";
function elementData(value, numberOf) {
  if (typeof value === "function")
    return { [handlerKey]: numberOf(value) };
  if (Array.isArray(value))
    return value.map((each) => elementData(each, numberOf));
  if (typeof value !== "object" || value === null)
    return value;
  if (unbuilt in value) {
    const { name, props } = value[unbuilt];
    if (name === "Client")
      throw new Error("Client draws only in panes and styles.");
    return { [elementKey]: name, props: elementData(props, numberOf) };
  }
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("a widget draws only the elements of ui/elements.js and ui/components.js, text, numbers, and plain objects.");
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, elementData(each, numberOf)]));
}
function elementOf(data, keyPrefix, press) {
  if (Array.isArray(data))
    return data.map((each) => elementOf(each, keyPrefix, press));
  if (typeof data !== "object" || data === null)
    return data;
  const fields = data;
  if (typeof fields[handlerKey] === "number") {
    const handler = fields[handlerKey];
    return (...args) => press(handler, JSON.parse(JSON.stringify(args)));
  }
  const name = fields[elementKey];
  if (name === undefined)
    return Object.fromEntries(Object.entries(fields).map(([key, each]) => [key, elementOf(each, keyPrefix, press)]));
  if (typeof name !== "string" || !(Object.hasOwn(constructors, name) || lowerings.has(name)))
    throw new Error(`a widget drew ${String(name)}, which is not an element of ui/elements.js or ui/components.js.`);
  const props = elementOf(fields["props"], keyPrefix, press);
  const keyed = typeof props["key"] === "string" ? { ...props, key: `${keyPrefix}${props["key"]}` } : props;
  return Object.hasOwn(constructors, name) ? constructors[name](keyed) : elementNamed(name, keyed);
}
var focusable = new Set(["Button", "Input", "Select"]);
function drawsFocusable(data, key) {
  if (typeof data !== "object" || data === null)
    return false;
  if (Array.isArray(data))
    return data.some((each) => drawsFocusable(each, key));
  const fields = data;
  const props = fields["props"];
  if (focusable.has(fields[elementKey]) && props?.["key"] === key)
    return true;
  return Object.values(fields).some((each) => drawsFocusable(each, key));
}
function forClaudeCode(table, surface, open, { hasNerdFont } = plainTerminal) {
  const { Button: button, Link: link, Image: image, Svg: svg, Raster: raster } = table;
  const opening = (props) => {
    const { href, ...rest } = props;
    if (typeof href !== "string")
      return button(props);
    const { label, children } = rest;
    const hasChildren = children !== undefined && !(Array.isArray(children) && children.length === 0);
    if (surface !== "terminal" && href.startsWith("https:"))
      return link({ href, ...typeof label === "string" ? { label } : {}, ...hasChildren ? { children } : {} });
    return button({ ...rest, onPress: (press) => open(href, press) });
  };
  const named = (draw) => ({ label, ...rest }) => draw({ alt: label, ...rest });
  const resolved = { ...table, Button: opening, Image: named(image), Svg: named(svg), Raster: ({ label, ...rest }) => raster(rest) };
  tableFacts.set(resolved, { hasNerdFont: hasNerdFont && surface === "terminal" });
  return resolved;
}
var Box = element("Box");
var Text = element("Text");
var Button = element("Button");
var Link = element("Link");
var Code = element("Code");
var Markdown = element("Markdown");
var Input = element("Input");
var Select = element("Select");
var Image = element("Image");
var Svg = element("Svg");
var Raster = element("Raster");
var Client = element("Client");
var constructors = { Box, Text, Button, Link, Code, Markdown, Input, Select, Image, Svg, Raster };

// node_modules/@cmodjs/core/runtime/buttons.js
function filledButton({ key, label, hotkey, variant = "secondary", onPress }) {
  const isPrimary = variant === "primary";
  return Button({
    plain: true,
    key,
    label,
    variant,
    ...hotkey === undefined ? {} : { hotkey },
    onPress,
    children: Text({ backgroundColor: isPrimary ? "claude" : "userMessageBackground", color: isPrimary ? "inverseText" : "text", bold: isPrimary, children: ` ${label} ` })
  });
}

// node_modules/@cmodjs/core/ui/areas.js
var BelowPrompt = "belowPrompt";
var Working = "working";
var TurnEnd2 = "turnEnd";
var Dashboard = "dashboard";

// node_modules/@cmodjs/core/ui/panes.js
var partId = /^[A-Za-z0-9_-]{1,64}$/;
var sizeKeys = ["columns", "rows"];
function checkPart(name, kind, id, title, takenBy) {
  if (!partId.test(id))
    throw new Error(`${name}: "${id}" is not a ${kind} id. Use 1 to 64 letters, digits, "_", or "-".`);
  if (title.trim() === "")
    throw new Error(`${name}: the ${kind} "${id}" needs a title, the label its tab shows.`);
  if (takenBy !== undefined)
    throw new Error(`${name}: the ${takenBy} "${id}" is already added. Give the ${kind} another id.`);
}
function checkPane(name, pane, takenBy) {
  checkPart(name, "pane", pane.id, pane.title, takenBy);
  for (const key of sizeKeys) {
    const size = pane[key];
    if (typeof size !== "function" && size !== undefined && (!Number.isInteger(size) || size <= 0))
      throw new Error(`${name}: the pane "${pane.id}" has ${key} ${size}. Use a whole number above 0, or leave it out.`);
  }
}

// node_modules/@cmodjs/core/ui/styles.js
var ToolGroup = "toolGroup";
var ToolProgress = "toolProgress";
var CommandOutput = "commandOutput";
var AskUserQuestion = "askUserQuestion";
var components = {
  prompt: "UserMessage",
  reply: "AssistantMessage",
  toolCall: "ToolUse",
  toolResult: "ToolResult",
  notice: "InfoNotice",
  [ToolGroup]: "ToolGroup",
  [ToolProgress]: "ToolProgress",
  [CommandOutput]: "CommandOutput",
  [AskUserQuestion]: "AskUserQuestion",
  [Working]: "Spinner",
  [TurnEnd2]: "TurnDuration"
};
function componentOf(kind) {
  return typeof kind === "string" && Object.hasOwn(components, kind) ? components[kind] : undefined;
}
function nameOf(kind) {
  return typeof kind === "string" ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : kind.name;
}

// node_modules/@cmodjs/core/runtime/ui.js
var partMethods = {
  list: "cmod:parts",
  draw: "cmod:draw",
  press: "cmod:press",
  shown: "cmod:shown",
  changed: "cmod:partsChanged",
  stylers: "cmod:markdownStylers"
};
var stalePress = "that button drew before the last redraw. Press the one it shows now.";
var unmeasuredColumns = 80;
function viewportColumns(e) {
  return e.viewport?.columns ?? unmeasuredColumns;
}
function styledAt(e, columns = viewportColumns(e)) {
  return { surface: e.surface, columns: Math.max(columns, 0) };
}
async function openLink(claude, href, surface) {
  if (surface === "terminal") {
    const [browser, sshConnection, display, waylandDisplay] = await Promise.all([claude.env.browser(), claude.env.sshConnection(), claude.env.display(), claude.env.waylandDisplay()]);
    const os = browser || sshConnection ? "" : (await claude.process.run(["uname", "-s"])).stdout.trim().toLowerCase();
    const command = browserCommand({ os, browser, sshConnection, display, waylandDisplay }, href);
    if (command !== undefined && (await claude.process.run(command)).exitCode === 0)
      return "opened";
  }
  const copied = await claude.ui.copy({ text: href, surface });
  if (!copied.isCopied)
    throw new Error(`cmod could not open ${href} or copy it: ${copied.reason}`);
  return "copied";
}
var bullet = "⏺";
function paneSize(pane, state) {
  const size = {};
  for (const key of sizeKeys) {
    const wanted = pane[key];
    const value = typeof wanted === "function" ? wanted(state) : wanted;
    if (value === undefined)
      continue;
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`the pane "${pane.id}" gets ${key} ${value} from its state. Return a whole number above 0, or undefined for Claude Code's default.`);
    size[key] = value;
  }
  return size;
}
function times(count) {
  return count === 1 ? "1 time" : `${count} times`;
}
function pieceProps(props, given, isFirst) {
  const merged = { ...props, ...given };
  return isFirst || !("isFirstOfReply" in merged) ? merged : { ...merged, isFirstOfReply: false };
}
function laterKeys(key) {
  let used = 0;
  return () => key === undefined ? undefined : `${key}:${used += 1}`;
}
function inheriting(props, draw, laterKey = laterKeys(props.key)) {
  const { dimColor, onLinkPress, pressableLinks } = props;
  const inherited = { ...dimColor === undefined ? {} : { dimColor }, ...onLinkPress === undefined ? {} : { onLinkPress }, ...pressableLinks === undefined ? {} : { pressableLinks } };
  let isKeyTaken = false;
  const keyOf = (left) => {
    if (left.key !== undefined)
      return left.key;
    if (isKeyTaken)
      return laterKey();
    isKeyTaken = true;
    return props.key;
  };
  return (left) => {
    const key = keyOf(left);
    return draw({ ...inherited, ...key === undefined ? {} : { key }, ...left });
  };
}
function threw(error) {
  return `threw, so Claude Code draws its own: ${messageOf(error)}`;
}
async function drawComponent(table, draw, drawDefault) {
  const calls = [];
  let first;
  try {
    first = drawWith(table, () => draw(({ children, ...props }) => {
      const drawing = table.Box({});
      calls.push({ given: props, drawing });
      return drawing;
    }));
  } catch (error) {
    return { failure: threw(error) };
  }
  if (calls.length === 0)
    return { drawing: first, isClaudesRow: false };
  const whole = calls.findIndex((call) => call.drawing === first);
  const pieces = await Promise.all(calls.map(({ given }, index) => drawDefault(given, index === whole)));
  let used = 0;
  let second;
  try {
    second = drawWith(table, () => draw(() => pieces[used++] ?? Box({})));
  } catch (error) {
    return { failure: threw(error) };
  }
  if (used !== pieces.length)
    return { failure: `used Default ${times(pieces.length)}, then ${times(used)}, so Claude Code draws its own. A render must draw the same for the same props.` };
  return { drawing: second, isClaudesRow: whole >= 0 };
}
function drawPieces(pieces, place) {
  const spaced = pieces.map(({ drawing, isClaudesRow }, index) => (index > 0 || place === "inReply") && !isClaudesRow ? Box({ marginTop: 1, children: drawing }) : drawing);
  const column = (drawings) => Box({ flexDirection: "column", children: drawings });
  const [opening, ...rest] = spaced;
  if (place !== "opensReply" || opening === undefined)
    return column(spaced);
  if (pieces[0]?.isClaudesRow !== true)
    return Box({ children: [Box({ minWidth: 2, children: Text({ color: "text", children: bullet }) }), column(spaced)] });
  return column([opening, Box({ paddingLeft: 2, children: column(rest) })]);
}
function merged(updates) {
  const parts = updates.findLast((update) => update.parts !== undefined)?.parts;
  const requests = updates.flatMap((update) => update.requests ?? []);
  const isRedrawn = updates.some((update) => update.redraw === true);
  const isStart = updates.some((update) => update.isStart === true);
  return { ...parts === undefined ? {} : { parts }, ...isRedrawn ? { redraw: true } : {}, ...requests.length === 0 ? {} : { requests }, ...isStart ? { isStart } : {} };
}
var keptDrawInputs = 200;
function createUi({ name, claude, router, report, announce, mod, borrowed, nextDraw, provided }) {
  const panes = new Map;
  const paneLogs = new Map;
  const openPanes = new Set;
  const paneStates = new Map;
  const syncPanes = async () => {
    const listed = new Map((await claude.ui.panes()).map((open) => [open.id, open]));
    for (const id of panes.keys()) {
      const open = listed.get(id);
      if (open?.isPlaced === true)
        openPanes.add(id);
      else
        openPanes.delete(id);
      if (open === undefined)
        paneStates.delete(id);
      else
        paneStates.set(id, { isShown: open.isShown, isFocused: open.isFocused });
    }
  };
  const readPanes = () => syncPanes().catch((error) => claude.ui.warn("panes:read", `${name} keeps its panes' open, shown, and focused state from before: ${messageOf(error)}`));
  const requestedSizes = new Map;
  const styles = new Set;
  const markdownRenders = new Map;
  let read;
  let stylers = [];
  let stylersSeen = 0;
  let isRouted = false;
  let isResizeQueued = false;
  const widgets = new Map;
  const widgetAreas = new Map;
  const parts = new Map;
  let shownParts = { open: [], shown: null, isFocused: false };
  const draws = new Map;
  const latestDraws = new Map;
  const failedDraws = new Set;
  let beforeStart = [];
  let askedDepth = 0;
  const askedCalls = new Set;
  let unheldRequests = 0;
  let collected;
  let collecting = 0;
  let queued;
  const partList = () => {
    const provides = [...provided(), ...markdownRenders.size > 0 ? [styleInterface] : []];
    return {
      widgets: [...widgets.values()].map(({ id, title, areas: listed, place }) => ({ id, title, areas: listed, ...place === undefined ? {} : { place } })),
      pages: [...parts.values()].map(({ init: { id, title }, place }) => ({ id, title, ...place === undefined ? {} : { place } })),
      ...provides.length === 0 ? {} : { provides }
    };
  };
  const hear = (listed, isRestyled) => {
    if (!Array.isArray(listed))
      return;
    const heard = listed.filter((styler) => typeof styler === "string" && styler !== name);
    if (!isRestyled && heard.join("\x00") === stylers.join("\x00"))
      return;
    stylers = heard;
    stylersSeen += 1;
    if (name === cmodPluginName || panes.size > 0)
      claude.ui.invalidate("ui.render");
  };
  const treeOf = (render, handlers) => {
    const drawn = render();
    return drawn === undefined ? null : elementData(drawn, (run) => handlers.push(run) - 1);
  };
  const isAnyDrawingChanged = () => {
    for (const [key, inputs] of latestDraws) {
      if (key === "markdown")
        continue;
      for (const sent of inputs.values()) {
        const handlers = [];
        try {
          if (JSON.stringify(treeOf(sent.render, handlers)) !== sent.tree)
            return true;
        } catch (error) {
          claude.ui.warn(`drawing:${key}`, `${name}: the ${key} drawing threw, so the cmod plugin asks for it again: ${messageOf(error)}`);
          return true;
        }
        const latest = sent.draws.at(-1);
        if (latest !== undefined && draws.has(latest))
          draws.set(latest, { id: key, handlers });
      }
    }
    return false;
  };
  const withNeededRedraw = ({ redraw, ...update }) => redraw === true && isAnyDrawingChanged() ? { ...update, redraw } : update;
  const send = (update) => {
    if (collected !== undefined)
      return void collected.push(update);
    if (beforeStart !== undefined)
      return void beforeStart.push(update);
    const isAsked = askedDepth > 0;
    if (queued !== undefined && !isAsked)
      return void queued.push(update);
    const batch = [update];
    if (!isAsked)
      queued = batch;
    const tell = async () => {
      if (queued === batch)
        queued = undefined;
      const needed = withNeededRedraw(merged(batch));
      if (Object.keys(needed).length === 0)
        return;
      const input = { ...needed, ...isAsked ? { isAsked: true } : {} };
      return claude.cmod.call({ to: cmodPluginName, method: partMethods.changed, input }).then((answer) => {
        if (isAsked && input.requests !== undefined && !(isObject(answer) && answer["isHeld"] === true))
          unheldRequests += 1;
        if (isObject(answer) && name !== cmodPluginName)
          hear(answer["stylers"], false);
      }, (error) => {
        claude.ui.warn("parts:tell", `${name}: the cmod plugin did not hear about its widgets, views, and pages: ${messageOf(error)}`);
      });
    };
    if (!isAsked)
      return Promise.resolve().then(tell);
    const told = tell().finally(() => askedCalls.delete(told));
    askedCalls.add(told);
    return told;
  };
  const asked = async (run) => {
    askedDepth += 1;
    try {
      const value = await run();
      while (askedCalls.size > 0)
        await Promise.allSettled(askedCalls);
      return value;
    } finally {
      askedDepth -= 1;
    }
  };
  const collect = async (run) => {
    collecting += 1;
    collected ??= [];
    try {
      await run();
    } finally {
      collecting -= 1;
    }
    const mine = collected;
    collected = collecting === 0 ? undefined : [];
    return withNeededRedraw(merged(mine));
  };
  const logOnce = (what) => {
    let hasLogged = false;
    return (failure) => {
      if (!hasLogged)
        report({ id: `draw:${what}`, message: `The ${what} failed`, description: failure });
      hasLogged = true;
    };
  };
  const renderOf = (type) => markdownRenders.get(type);
  const drawnBlock = (piece, at, drawClaudes, keyPrefix, table) => {
    if ("text" in piece)
      return drawClaudes({ text: piece.text });
    const { render, props: block } = piece;
    const draw = () => drawKeyed(keyPrefix, () => render.Component({ ...block, ...at, Default: ({ source = block.source }) => drawClaudes({ text: source }) }));
    try {
      return table === undefined ? draw() : drawWith(table, draw, drawClaudes);
    } catch (error) {
      render.log(threw(error));
      return drawClaudes({ text: block.source });
    }
  };
  const othersFrom = (table, at, from, unkeyedScope) => (props, laterKey = laterKeys(props.key)) => {
    if (from >= stylers.length)
      return table.Markdown(props);
    const scope = props.key ?? unkeyedScope();
    for (const [index, styler] of stylers.entries()) {
      if (index < from)
        continue;
      const cached = `${stylersSeen}\x00${at.surface}\x00${at.columns}\x00${props.text}`;
      const next = othersFrom(table, at, index + 1, unkeyedScope);
      const drawn = drawWith(table, () => borrowed(styler, cached, { markdown: props.text, ...at }, scope), inheriting(props, (part) => next(part, laterKey), laterKey));
      if (drawn !== undefined)
        return drawn;
    }
    return table.Markdown(props);
  };
  const markdownIn = (table, at) => {
    const reader = read;
    let unkeyed = 0;
    const unkeyedScope = () => String(unkeyed++);
    const others = othersFrom(table, at, 0, unkeyedScope);
    if (reader === undefined)
      return stylers.length === 0 ? undefined : others;
    return (props) => {
      const pieces = reader(props.text, renderOf);
      if (pieces.every((piece) => ("text" in piece)))
        return others(props);
      const scope = props.key ?? unkeyedScope();
      const laterKey = laterKeys(props.key);
      const drawClaudes = inheriting(props, (part) => others(part, laterKey), laterKey);
      const drawings = pieces.map((piece, index) => drawnBlock(piece, at, drawClaudes, `${scope}:${index}:`, table));
      return drawPieces(drawings.map((drawing) => ({ drawing, isClaudesRow: false })), "pane");
    };
  };
  const markdownDrawing = (text, at) => {
    const pieces = read === undefined ? [] : read(text, renderOf);
    if (pieces.every((piece) => ("text" in piece)))
      return Markdown({ text });
    return drawPieces(pieces.map((piece, index) => ({ drawing: drawnBlock(piece, at, Markdown, `${index}:`), isClaudesRow: false })), "pane");
  };
  const routeMarkdown = (createReader) => {
    if (read !== undefined)
      return;
    const reader = createReader();
    read = reader;
    router.add("ui.render", async (e, next) => {
      if (e.component !== "AssistantMessage")
        return next(e);
      const pieces = reader(e.props.text, renderOf, e.requestId);
      if (pieces.every((piece) => ("text" in piece)))
        return next(e);
      const table = claude.ui.resolve(e);
      const drawClaudes = (text, isFirst) => next({ ...e, props: pieceProps(e.props, { text }, isFirst) });
      const drawn = await Promise.all(pieces.map(async (piece, index) => {
        if ("text" in piece)
          return { drawing: await drawClaudes(piece.text, index === 0), isClaudesRow: true };
        const { render, props: block } = piece;
        const component = await drawComponent(table, (Default) => drawKeyed(`${index}:`, () => render.Component({ ...block, ...styledAt(e), id: e.requestId, Default })), ({ source = block.source }, isClaudesRow) => drawClaudes(source, index === 0 && isClaudesRow));
        if (!("failure" in component))
          return component;
        render.log(component.failure);
        return { drawing: await drawClaudes(block.source, index === 0), isClaudesRow: true };
      }));
      return drawWith(table, () => drawPieces(drawn, e.props.isFirstOfReply ? "opensReply" : "inReply"));
    });
  };
  const openAt = (pane, size, focus) => {
    requestedSizes.set(pane.id, size);
    const { id, title, closeOnEscape, holdToasts } = pane;
    return claude.ui.open({ id, title, ...size, ...closeOnEscape === true ? { closeOnEscape } : {}, ...holdToasts === true ? { holdToasts } : {}, ...focus === true ? { focus } : {} });
  };
  const resize = async (pane) => {
    try {
      const size = paneSize(pane, mod().state);
      const requested = requestedSizes.get(pane.id);
      if (requested?.columns === size.columns && requested?.rows === size.rows)
        return;
      await openAt(pane, size);
    } catch (error) {
      claude.ui.warn(`pane:resize:${pane.id}`, `${name}: the ${pane.title} pane kept its size: ${messageOf(error)}`);
    }
  };
  const handle = async (pane, handler, run) => {
    try {
      await run();
    } catch (error) {
      report({ id: `pane:${pane.id}:${handler}`, message: `The ${pane.title} pane's ${handler} threw`, error });
    }
  };
  const routePanes = () => {
    if (isRouted)
      return;
    isRouted = true;
    router.add("ui.render", (e, next) => {
      const added = panes.get(e.requestId);
      if (added === undefined || e.component !== "Pane")
        return next(e);
      const { init } = added;
      openPanes.add(init.id);
      paneStates.set(init.id, { isShown: true, isFocused: e.props.isFocused });
      readPanes();
      const table = claude.ui.resolve(e);
      try {
        return drawWith(table, () => init.render(mod(), { ...e.props, surface: e.surface, params: added.params }), markdownIn(table, styledAt(e, e.props.bodyColumns)));
      } catch (error) {
        paneLogs.get(init.id)?.(`threw: ${messageOf(error)}`);
        return drawWith(table, () => Text({ color: "error", children: `The ${init.title} pane could not draw: ${messageOf(error)}` }));
      }
    });
    router.add("ui.scroll", async (e, next) => {
      const init = panes.get(e.requestId)?.init;
      const moved = await next(e);
      if (init?.onScroll === undefined || e.component !== "Pane" || moved.deny !== undefined)
        return moved;
      await handle(init, "onScroll", () => init.onScroll?.(mod(), e));
      return moved;
    });
    router.add("ui.close", async (e, next) => {
      openPanes.delete(e.id);
      paneStates.delete(e.id);
      const closed = await next(e);
      await readPanes();
      const init = panes.get(e.id)?.init;
      if (init?.onClose !== undefined)
        await handle(init, "onClose", () => init.onClose?.(mod(), e));
      return closed;
    });
  };
  const scrollIn = (id, target, options) => claude.ui.scroll({ to: target, in: id, ...options?.block === undefined ? {} : { block: options.block } }).then(({ deny }) => {
    if (deny !== undefined)
      throw new Error(`${name}: Claude Code did not scroll ${id}: ${deny}`);
  });
  const addPane = (init) => {
    checkPane(name, init, panes.has(init.id) ? "pane" : undefined);
    const added = { init, params: undefined };
    panes.set(init.id, added);
    paneLogs.set(init.id, logOnce(`${init.title} pane`));
    announce(`the ${init.title} pane`);
    routePanes();
    const sized = init;
    const pane = {
      id: init.id,
      get isOpen() {
        return openPanes.has(init.id);
      },
      get isShown() {
        return paneStates.get(init.id)?.isShown ?? false;
      },
      get isFocused() {
        return paneStates.get(init.id)?.isFocused ?? false;
      },
      get params() {
        return added.params;
      },
      async open(...[options]) {
        if (options !== undefined && "params" in options)
          added.params = options.params;
        const { isPlaced } = await openAt(sized, paneSize(sized, mod().state), options?.focus);
        if (isPlaced)
          openPanes.add(init.id);
        await syncPanes();
        claude.ui.invalidate("ui.render");
      },
      async close() {
        await claude.ui.close({ id: init.id });
        openPanes.delete(init.id);
        paneStates.delete(init.id);
        await syncPanes();
      },
      toggle: (options) => openPanes.has(init.id) ? pane.close() : pane.open(options),
      scrollTo: (target, options) => scrollIn(init.id, target, options),
      async focus(key) {
        const { deny } = await claude.ui.focus({ requestId: init.id, key });
        if (deny !== undefined)
          throw new Error(`${name}: Claude Code did not focus "${key}" in the ${init.title} pane: ${deny}`);
      },
      remove() {
        if (panes.get(init.id) !== added)
          return;
        panes.delete(init.id);
        paneLogs.delete(init.id);
        if (openPanes.has(init.id))
          claude.ui.close({ id: init.id }).catch((error) => claude.ui.warn(`pane:close:${init.id}`, `${name}: the ${init.title} pane stayed open: ${messageOf(error)}`));
        openPanes.delete(init.id);
        paneStates.delete(init.id);
      }
    };
    return pane;
  };
  const openEntry = (id) => shownParts.open.find((each) => each.id === id);
  const takenBy = (id) => widgets.has(id) ? "widget" : parts.get(id)?.kind;
  const addPart = (kind, init, place) => {
    checkPart(name, kind, init.id, init.title, takenBy(init.id));
    const added = { init, kind, place, params: undefined };
    const key = `${kind}:${init.id}`;
    let requested;
    parts.set(init.id, added);
    announce(place === "settings" ? `the ${init.title} view in Settings` : `the ${init.title} ${kind}`);
    send({ parts: partList() });
    const part = {
      id: init.id,
      get isOpen() {
        if (requested?.[0] === shownParts)
          return requested[1];
        return place === "settings" ? shownParts.shown === init.id : openEntry(init.id) !== undefined;
      },
      get isShown() {
        return [shownParts.shown, ...shownParts.inApps ?? []].includes(init.id);
      },
      get isFocused() {
        return shownParts.shown === init.id && shownParts.isFocused;
      },
      get params() {
        return openEntry(init.id)?.params ?? added.params;
      },
      async open(...[options]) {
        if (options !== undefined && "params" in options)
          added.params = options.params;
        requested = [shownParts, true];
        await send({ requests: [{ open: init.id, ...added.params === undefined ? {} : { params: added.params }, ...options?.focus === true ? { focus: true } : {} }] });
      },
      toggle: (options) => part.isOpen ? part.close() : part.open(options),
      close: async () => {
        requested = [shownParts, false];
        await send({ requests: [{ close: init.id }] });
      },
      scrollTo: async (target, options) => {
        await send({ requests: [{ scroll: init.id, to: target, ...options?.block === undefined ? {} : { block: options.block } }] });
      },
      focus: async (focused) => {
        const latest = [...latestDraws.get(key)?.values() ?? []].at(-1);
        if (latest === undefined || !drawsFocusable(treeOf(latest.render, []), focused))
          throw new Error(`${name}: the ${init.title} ${kind} draws no Button, Input, or Select with the key "${focused}".`);
        await send({ requests: [{ focus: init.id, key: focused }] });
      },
      remove() {
        if (parts.get(init.id) !== added)
          return;
        parts.delete(init.id);
        forgetDraws(key);
        send({ parts: partList(), requests: [{ close: init.id }] });
      }
    };
    return part;
  };
  const addWidget = (init) => {
    checkPart(name, "widget", init.id, init.title, takenBy(init.id));
    widgets.set(init.id, init);
    announce(`the ${init.title} widget`);
    send({ parts: partList() });
    return {
      id: init.id,
      get area() {
        return widgetAreas.get(init.id);
      },
      remove() {
        if (widgets.get(init.id) !== init)
          return;
        widgets.delete(init.id);
        widgetAreas.delete(init.id);
        forgetDraws(`widget:${init.id}`);
        send({ parts: partList() });
      }
    };
  };
  const addStyle = ({ kind, render }) => {
    const markdown = typeof kind === "string" ? undefined : kind;
    const component = componentOf(kind);
    if (markdown === undefined && component === undefined)
      throw new Error(`${name}: ${String(kind)} is not a kind styles.add draws, such as ToolCall or CodeBlock.`);
    const feature = `the style of ${nameOf(kind)}`;
    if (styles.has(feature))
      throw new Error(`${name}: ${feature} is already added. Add one style per kind.`);
    styles.add(feature);
    announce(feature);
    const Component = (props) => render(mod(), props);
    const stop = (subscription) => () => {
      subscription?.remove();
      if (markdown !== undefined && markdownRenders.delete(markdown.markdown))
        send({ parts: partList() });
      styles.delete(feature);
      claude.ui.invalidate("ui.render");
    };
    if (markdown !== undefined) {
      markdownRenders.set(markdown.markdown, { Component, log: logOnce(`${nameOf(kind)} style`) });
      routeMarkdown(markdown.createReader);
      send({ parts: partList() });
      return { kind, remove: stop() };
    }
    const log = logOnce(`${nameOf(kind)} style`);
    const drawing = router.add("ui.render", async (e, next) => {
      if (e.component !== component)
        return next(e);
      const table = claude.ui.resolve(e);
      const drawn = await drawComponent(table, (Default) => Component({ ...e.props, ...styledAt(e), id: e.requestId, Default }), (given, isClaudesRow) => next({ ...e, props: pieceProps(e.props, given, isClaudesRow) }));
      if ("failure" in drawn) {
        log(drawn.failure);
        return next(e);
      }
      if (e.component !== "AssistantMessage")
        return drawn.drawing;
      return drawWith(table, () => drawPieces([drawn], e.props.isFirstOfReply ? "opensReply" : "inReply"));
    });
    return { kind, remove: stop(drawing) };
  };
  const forgetDraws = (key) => {
    for (const kept of latestDraws.get(key)?.values() ?? [])
      for (const draw of kept.draws)
        draws.delete(draw);
    latestDraws.delete(key);
  };
  const drawPart = (key, title, input, render, drawFailure = () => {
    return;
  }) => {
    let handlers = [];
    let tree;
    try {
      tree = treeOf(render, handlers);
      failedDraws.delete(key);
    } catch (error) {
      if (!failedDraws.has(key))
        report({ id: key, message: `The ${title} could not draw`, error });
      failedDraws.add(key);
      handlers = [];
      tree = treeOf(() => drawFailure(error), handlers);
    }
    const number = nextDraw();
    const inputs = latestDraws.get(key) ?? new Map;
    latestDraws.set(key, inputs);
    const drawnFor = JSON.stringify("turn" in input ? { ...input, turn: input.turn.prompt.id } : input);
    const earlier = inputs.get(drawnFor)?.draws ?? [];
    const kept = [...earlier, number].slice(-2);
    for (const draw of earlier)
      if (!kept.includes(draw))
        draws.delete(draw);
    inputs.delete(drawnFor);
    inputs.set(drawnFor, { draws: kept, tree: JSON.stringify(tree), render });
    const [oldest] = inputs;
    if (inputs.size > keptDrawInputs && oldest !== undefined) {
      for (const draw of oldest[1].draws)
        draws.delete(draw);
      inputs.delete(oldest[0]);
    }
    draws.set(number, { id: key, handlers });
    return { draw: number, tree };
  };
  const draw = (input) => {
    if ("markdown" in input)
      return drawPart("markdown", "markdown style", input, () => markdownDrawing(input.markdown, { surface: input.surface, columns: input.columns }));
    if ("page" in input) {
      const { page, ...props } = input;
      const added = parts.get(page);
      if (added === undefined)
        throw new Error(`${name} has no view or page ${page}.`);
      const title = `${added.init.title} ${added.kind}`;
      return drawPart(`${added.kind}:${page}`, title, input, () => added.init.render(mod(), props), (error) => Text({ color: "error", children: `The ${title} could not draw: ${messageOf(error)}` }));
    }
    const { widget: id, turn, ...given } = input;
    const widget = widgets.get(id);
    if (widget === undefined || !widget.areas.includes(given.area))
      return null;
    widgetAreas.set(id, given.area);
    const context = given.area === TurnEnd2 && turn !== undefined ? { ...given, turn } : given;
    return drawPart(`widget:${id}`, `${widget.title} widget`, input, () => widget.render(mod(), context));
  };
  const press = async ({ draw: drawn, handler, args }, caller) => {
    const known = draws.get(drawn);
    const run = known?.handlers[handler];
    if (known === undefined || run === undefined)
      throw new Error(`${name}: ${stalePress}`);
    if (caller !== cmodPluginName && known.id !== "markdown")
      throw new Error(`${name}: ${caller} pressed a button only the cmod plugin draws.`);
    const pressed = async () => {
      try {
        await run(...args);
      } catch (error) {
        report({ id: known.id, message: "Its button failed", error, isCritical: true });
      }
    };
    if (caller === cmodPluginName)
      return collect(pressed);
    await pressed();
    return null;
  };
  return {
    panes: { add: addPane },
    views: { add: (init) => addPart("view", init, "sidebar") },
    pages: { add: (init) => addPart("page", init) },
    settings: {
      add: (init) => addPart("view", init, "settings"),
      open: async () => {
        await send({ requests: [{ settings: true }] });
      }
    },
    widgets: { add: addWidget },
    styles: { add: addStyle },
    asked,
    async answerInput(run, passInput) {
      const before = unheldRequests;
      const answer = await asked(run);
      if (unheldRequests > before)
        await passInput();
      return answer;
    },
    answer(method, input, caller) {
      const isMarkdown = method === partMethods.draw && isObject(input) && typeof input["markdown"] === "string";
      if (caller !== cmodPluginName && !isMarkdown && method !== partMethods.press)
        return;
      if (method === partMethods.list)
        return Promise.resolve({ value: partList() });
      if (method === partMethods.draw)
        return Promise.resolve().then(() => ({ value: draw(input) }));
      if (method === partMethods.press)
        return press(input, caller).then((value) => ({ value }));
      if (method === partMethods.shown) {
        shownParts = input;
        return Promise.resolve({ value: null });
      }
      if (method === partMethods.stylers) {
        hear(input, true);
        return Promise.resolve({ value: null });
      }
      return;
    },
    markdownIn,
    restyled: (stylers) => hear(stylers, true),
    relisted() {
      send({ parts: partList() });
    },
    started() {
      const held = merged(beforeStart ?? []);
      beforeStart = undefined;
      send({ ...held, parts: partList(), isStart: true });
    },
    changed() {
      if (widgets.size > 0 || parts.size > 0)
        send({ redraw: true });
      if (panes.size === 0 && styles.size === 0)
        return;
      claude.ui.invalidate("ui.render");
      if (isResizeQueued)
        return;
      isResizeQueued = true;
      Promise.resolve().then(() => {
        isResizeQueued = false;
        for (const { init } of panes.values()) {
          if (openPanes.has(init.id))
            resize(init);
        }
      });
    },
    async restorePanes() {
      if (panes.size > 0)
        await syncPanes();
    }
  };
}

// node_modules/@cmodjs/core/runtime/installer.js
var installView = "cmod:install";
var keptDraws = 8;
function createInstaller(name, claude, waiting, nextDraw) {
  let question;
  let isOpen = false;
  let isSeen = false;
  let waitingForShow = [];
  let collected;
  const draws = new Map;
  const send = async (update) => {
    if (collected !== undefined)
      return void collected.push(update);
    await withBareRefusals(claude()).cmod.call({ to: cmodPluginName, method: partMethods.changed, input: update });
  };
  const log = (what) => (error) => claude().ui.warn("installer:page", `${name}: ${what}: ${messageOf(error)}`);
  const open = (isAsked) => send({ requests: [{ open: installView, focus: true }], ...isAsked ? { isAsked: true } : {} });
  const show = async (next, build, cancelled) => {
    question?.cancel();
    const answer = new Promise((resolve) => {
      let isAnswered = false;
      const done = (value) => {
        if (isAnswered)
          return;
        isAnswered = true;
        waiting.hide();
        claude().clock.after(0, () => resolve(value));
      };
      question = { ...build(done), cancel: () => done(cancelled) };
    });
    waiting.show(() => open(true), next);
    if (isOpen) {
      await send({ redraw: true }).catch(log("the installer did not redraw"));
    } else {
      isOpen = true;
      await open(false).catch((error) => {
        isOpen = false;
        waiting.hide();
        throw error;
      });
    }
    for (const resolve of waitingForShow)
      resolve();
    waitingForShow = [];
    return answer;
  };
  const redraw = () => void send({ redraw: true }).catch(log("the installer did not redraw"));
  const actions = (...buttons) => Box({ gap: 2, flexShrink: 0, children: buttons });
  const dialog = (title, ...children) => Box({ flexDirection: "column", gap: 1, children: [title, ...children] });
  const draw = (props) => {
    if (question === undefined && !isOpen)
      claude().clock.after(0, () => void send({ requests: [{ close: installView }] }).catch(log("a leftover install view stayed open")));
    const handlers = [];
    const tree = elementData(question?.draw(props) ?? Text({ dimColor: true, children: `${name} needs nothing from you now.` }), (run) => handlers.push(run) - 1);
    const drawn = nextDraw();
    draws.set(drawn, handlers);
    for (const kept of draws.keys())
      if (draws.size > keptDraws)
        draws.delete(kept);
    return { draw: drawn, tree };
  };
  const collect = async (run) => {
    const outer = collected;
    const mine = [];
    collected = mine;
    try {
      await run();
    } finally {
      collected = outer;
    }
    return merged(mine);
  };
  const press = async ({ draw: drawn, handler, args }) => {
    const run = draws.get(drawn)?.[handler];
    if (run === undefined)
      throw new Error(`${name}: ${stalePress}`);
    return collect(() => run(...args));
  };
  return {
    answer(method, input) {
      const { page, ...props } = isObject(input) ? input : {};
      if (method === partMethods.draw && page === installView)
        return Promise.resolve({ value: draw({ ...props, params: undefined }) });
      if (method === partMethods.press && isObject(input) && typeof input["draw"] === "number" && draws.has(input["draw"]))
        return press(input).then((value) => ({ value }));
      return;
    },
    hear(shown) {
      if (shown.open.some((each) => each.id === installView)) {
        isSeen = isOpen;
        return;
      }
      if (!isSeen)
        return;
      isOpen = false;
      isSeen = false;
      question?.cancel();
    },
    options(missing, save) {
      const saved = new Map;
      const failures = new Map;
      return show(`Enter ${missing.length === 1 ? "one setting" : `${missing.length} settings`}`, (answer) => ({
        draw: () => dialog(Text({ bold: true, children: `Set up ${name}` }), Text({ children: `${name} needs ${missing.length === 1 ? "one setting" : `${missing.length} settings`}:` }), ...missing.map(([key, option]) => {
          const label = Box({ flexDirection: "column", children: [Text({ bold: true, children: option.title }), ...option.description === "" ? [] : [Text({ dimColor: true, wrap: "wrap", children: option.description })]] });
          if (option.type === "secret") {
            return Box({ flexDirection: "column", children: [label, Text({ dimColor: true, wrap: "wrap", children: `${secretFix} Then press Next.` }), filledButton({ key: `secret:${key}`, label: "Open /config", onPress: () => void claude().command.run({ command: "config" }) })] });
          }
          const failure = failures.get(key);
          const field = Input({
            key: `option:${key}`,
            label: "Value",
            placeholder: option.type === "choice" ? (option.choices ?? []).join(", ") : option.type === "toggle" ? "true or false" : option.type === "list" ? "comma-separated" : "",
            value: saved.get(key) ?? "",
            submitLabel: "save",
            onSubmit: (value) => void save(key, value).then((refused) => {
              if (refused === undefined) {
                saved.set(key, value);
                failures.delete(key);
              } else
                failures.set(key, refused);
            }).catch((error) => failures.set(key, messageOf(error))).finally(redraw)
          });
          const status = failure !== undefined ? [Text({ color: "error", wrap: "wrap", children: failure })] : saved.has(key) ? [Text({ color: "success", children: "✓ saved" })] : [];
          return Box({ flexDirection: "column", children: [label, field, ...status] });
        }), actions(filledButton({ key: "next", hotkey: "x", variant: "primary", label: "Next", onPress: () => answer(true) }), filledButton({ key: "not-now", hotkey: "n", label: "Not now", onPress: () => answer(false) })))
      }), false);
    },
    step(mod, step, index, total) {
      let notice;
      return show(`Step ${index} of ${total}: ${step.title}`, (answer) => ({
        draw: (props) => {
          let body;
          try {
            body = step.render(mod, props);
          } catch (error) {
            body = Text({ color: "error", wrap: "wrap", children: `The ${step.title} step could not draw: ${messageOf(error)}` });
          }
          const next = async () => {
            try {
              if (await step.isDone(mod))
                return answer(true);
              notice = { color: "warning", text: `Finish ${step.title} first.` };
            } catch (error) {
              notice = { color: "error", text: `The ${step.title} step's isDone failed: ${messageOf(error)}` };
            }
            await send({ redraw: true });
          };
          return dialog(Text({ children: [Text({ bold: true, children: step.title }), Text({ dimColor: true, children: `  (${index} of ${total})` })] }), body, ...notice === undefined ? [] : [Text({ color: notice.color, wrap: "wrap", children: notice.text })], actions(filledButton({ key: "next", hotkey: "x", variant: "primary", label: index === total ? "Finish" : "Next", onPress: () => void next() }), filledButton({ key: "not-now", hotkey: "n", label: "Not now", onPress: () => answer(false) })));
        }
      }), false);
    },
    async close() {
      question?.cancel();
      question = undefined;
      if (!isOpen)
        return;
      isOpen = false;
      isSeen = false;
      await send({ requests: [{ close: installView }] }).catch(log("the install view stayed open"));
    },
    changed() {
      if (question !== undefined && isOpen)
        redraw();
    },
    shown: () => new Promise((resolve) => void waitingForShow.push(resolve)),
    collect
  };
}

// node_modules/@cmodjs/core/runtime/options.js
class MissingOptions extends Error {
  keys;
  titles;
  constructor(keys, titles) {
    super(`it needs ${listed(titles)}`);
    this.keys = keys;
    this.titles = titles;
  }
}
function createOptions({ name, declared, fromClaude, claude, report, changed }) {
  let values = merged2(declared, fromClaude, {}, new Set);
  let locked;
  let loadedRoot;
  const readLocked = async () => {
    if (Object.keys(declared).length === 0)
      return new Set;
    const rows = await claude.config.list().catch((error) => {
      claude.ui.warn("options:config", `${name} could not read /config, so a project's options.json may override a value your organization set: ${messageOf(error)}`);
      return [];
    });
    return new Set(rows.filter((row) => row.isLocked && row.key.startsWith(`${name}.`)).map((row) => row.key.slice(name.length + 1)));
  };
  const readProject = async (root) => {
    const path = `${projectConfigFolder(root, name)}/options.json`;
    if (!await claude.fs.exists(path))
      return {};
    const { values: kept, ignored } = projectOptionsOf(name, declared, await claude.fs.read(path));
    for (const reason of ignored)
      report({ id: `options:${path} ${reason}`, message: `Ignores part of ${path}`, description: `${path} ${reason}` });
    return kept;
  };
  return {
    get values() {
      return values;
    },
    get missing() {
      return Object.entries(declared).filter(([key, option]) => option.default === undefined && isUnset(values[key])).map(([key]) => key);
    },
    async load(root) {
      if (Object.keys(declared).length === 0)
        return;
      locked ??= await readLocked();
      const project = await readProject(root);
      const isFirst = loadedRoot === undefined;
      loadedRoot = root;
      const next = merged2(declared, fromClaude, project, locked);
      if (!isFirst && JSON.stringify(next) === JSON.stringify(values))
        return;
      values = next;
      if (!isFirst)
        changed();
    }
  };
}
function merged2(declared, fromClaude, project, locked) {
  return Object.freeze(Object.fromEntries(Object.entries(declared).map(([key, option]) => [key, valueOf(key, option, fromClaude[key], project, locked)])));
}
function valueOf(key, option, own, project, locked) {
  if (locked.has(key))
    return own;
  if (Object.hasOwn(project, key))
    return project[key];
  if (!isUnset(own) && fitsOption(option, own) === undefined)
    return Array.isArray(own) ? Object.freeze([...own]) : own;
  return option.default ?? (option.type === "list" ? Object.freeze([]) : option.type === "number" ? undefined : "");
}

// node_modules/@cmodjs/core/runtime/state.js
var lifetimes = ["memory", "session", "project", "global"];
var keptProjects = 20;
var listeners = new WeakMap;
function sessionKeyOf(name, key, session) {
  return `${name}.${key}.sessions.${session}`;
}
function createState({ name, initial, session, root, claude, report, changed: redraw, forkParent }) {
  const changed = () => {
    redraw();
    for (const listener of listeners.get(state) ?? [])
      listener();
  };
  const declared = declaredGroups(name, initial);
  const current = copied(declared);
  let projectRoot = root;
  let sessionId = session;
  let turn = Promise.resolve();
  const inTurn = (task) => {
    const run = turn.then(task);
    turn = Promise.allSettled([run]);
    return run;
  };
  const ownersKey = (lifetime, key) => lifetime === "project" ? `${name}.${key}.projects.` : sessionKeyOf(name, key, "");
  const storeKey = (lifetime, key, owner) => lifetime === "global" ? `${name}.${key}` : `${ownersKey(lifetime, key)}${owner}`;
  const read = (lifetime, key, owner) => claude.store.get(storeKey(lifetime, key, owner));
  const write = async (lifetime, key, value, owner) => {
    if (lifetime !== "project")
      return claude.store.set(storeKey(lifetime, key, owner), value);
    await claude.store.delete(storeKey(lifetime, key, owner));
    await claude.store.set(storeKey(lifetime, key, owner), value);
    const owners = (await claude.store.keys()).filter((stored) => stored.startsWith(ownersKey(lifetime, key)));
    for (const oldest of owners.slice(0, -keptProjects))
      await claude.store.delete(oldest);
  };
  const transcriptsKey = `${name}.$transcripts.`;
  const forgetEndedSessions = async (current) => {
    const stored = await claude.store.keys();
    const ended = async (recorded) => {
      const transcript = await claude.store.get(recorded);
      return typeof transcript !== "string" || !await claude.fs.exists(transcript);
    };
    const owners = stored.filter((key) => key.startsWith(transcriptsKey) && key !== `${transcriptsKey}${current}`);
    await Promise.all(owners.map(async (recorded) => {
      if (!await ended(recorded))
        return;
      const owner = recorded.slice(transcriptsKey.length);
      await Promise.all(stored.filter((key) => key.startsWith(`${name}.`) && key.endsWith(`.sessions.${owner}`)).map((value) => claude.store.delete(value)));
      await claude.store.delete(recorded);
    }));
  };
  const loadGroups = async (only, next) => {
    const loaded = [];
    for (const lifetime of only) {
      for (const key of Object.keys(declared[lifetime]))
        loaded.push([lifetime, key, lifetime === "memory" ? undefined : await read(lifetime, key, lifetime === "project" ? next.root : next.session)]);
    }
    projectRoot = next.root;
    sessionId = next.session;
    for (const [lifetime, key, saved] of loaded)
      current[lifetime][key] = saved === undefined ? declared[lifetime][key] : frozen(name, `${lifetime}.${key}`, saved);
    changed();
  };
  const copySession = async (from, to) => {
    for (const key of Object.keys(declared.session)) {
      const saved = await read("session", key, from);
      if (saved !== undefined)
        await write("session", key, saved, to);
    }
  };
  const hasSaved = async (owner) => (await claude.store.keys()).some((key) => key.startsWith(`${name}.`) && key.endsWith(`.sessions.${owner}`));
  const group = (lifetime) => new Proxy(current[lifetime], {
    set(target, key, value) {
      if (typeof key !== "string")
        throw new Error(`${name}: mod.state.${lifetime} keys are text, not ${String(key)}.`);
      if (!Object.hasOwn(declared[lifetime], key))
        throw new Error(`${name}: mod.state.${lifetime}.${key} is not declared. Add it to state.${lifetime} in defineMod with its starting value.`);
      if (Object.is(target[key], value))
        return true;
      target[key] = frozen(name, `${lifetime}.${key}`, value);
      if (lifetime !== "memory") {
        const owner = lifetime === "project" ? projectRoot : sessionId;
        inTurn(() => write(lifetime, key, value, owner)).catch((error) => {
          report({ id: `state:${lifetime}.${key}`, message: `Could not keep state.${lifetime}.${key}`, error });
        });
      }
      changed();
      return true;
    }
  });
  const state = Object.freeze(Object.fromEntries(Object.keys(initial).map((lifetime) => [lifetime, group(lifetime)])));
  return {
    state,
    get root() {
      return projectRoot;
    },
    changed,
    load: () => inTurn(async () => {
      if (Object.keys(declared.session).length > 0 && !await hasSaved(sessionId)) {
        const parent = await forkParent();
        if (parent !== undefined)
          await copySession(parent, sessionId);
      }
      return loadGroups(lifetimes, { root: projectRoot, session: sessionId });
    }),
    moveTo: (nextRoot) => inTurn(async () => nextRoot === projectRoot ? undefined : loadGroups(["project"], { root: nextRoot, session: sessionId })),
    switchSession: (nextSession, source, transcript) => inTurn(async () => {
      if (Object.keys(declared.session).length > 0) {
        await claude.store.set(`${transcriptsKey}${nextSession}`, transcript);
        forgetEndedSessions(nextSession).catch((error) => report({ id: "state:sessions", message: "Could not forget the session values of ended sessions", error }));
      }
      if (nextSession === sessionId)
        return;
      if (source === "fork")
        await copySession(sessionId, nextSession);
      return loadGroups(["memory", "session"], { root: projectRoot, session: nextSession });
    })
  };
}
function declaredGroups(name, initial) {
  const groups = { memory: {}, session: {}, project: {}, global: {} };
  for (const [lifetime, values] of Object.entries(initial)) {
    if (!isLifetime(lifetime))
      throw new Error(`${name}: state.${lifetime} is not a lifetime. Put each value in state.memory, state.session, state.project, or state.global.`);
    if (!isPlainObject(values))
      throw new Error(`${name}: state.${lifetime} is not an object of values. Write state: { ${lifetime}: { key: value } }.`);
    for (const [key, value] of Object.entries(values))
      groups[lifetime][key] = frozen(name, `${lifetime}.${key}`, value);
  }
  return groups;
}
function copied(groups) {
  return { memory: { ...groups.memory }, session: { ...groups.session }, project: { ...groups.project }, global: { ...groups.global } };
}
function isLifetime(group) {
  return lifetimes.includes(group);
}
function frozen(name, path, value) {
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value))
    return value;
  const copy = isArray ? value.map((item) => frozen(name, path, item)) : Object.fromEntries(Object.entries(value).map(([field, item]) => [field, frozen(name, path, item)]));
  const example = isArray ? `mod.state.${path} = [...mod.state.${path}, item]` : `mod.state.${path} = { ...mod.state.${path}, field: value }`;
  const refuse = () => {
    throw new Error(`${name}: mod.state.${path} cannot change in place. Assign it a new value, such as ${example}, so the mod redraws and keeps it.`);
  };
  return new Proxy(Object.freeze(copy), { set: refuse, defineProperty: refuse, deleteProperty: refuse });
}
function isPlainObject(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// node_modules/@cmodjs/core/runtime/toaster.js
var failedMethod = "cmod:failed";
var githubRepository = /^https:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?(?:\/issues)?\/?$/;
var linkLimit = 2048;
var hiddenKey = "cmod:hidden-failures";
var failedCallMs = 30000;
var logAgainMs = [1e4, 60000, 300000];
var defaultDuration = 4000;
var visibleToasts = 3;
var columnGap = 2;
var nameColumn = 16;
var spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
var spinnerMs = 100;
var spinFrames = 1e4 / spinnerMs;
var still = "…";
var icons = {
  default: { glyph: " " },
  success: { glyph: "✓", color: "success" },
  info: { glyph: "ℹ", color: "suggestion" },
  warning: { glyph: "⚠", color: "warning" },
  error: { glyph: "✗", color: "error" }
};
function createToaster(claude, name, version) {
  const entries = new Map;
  const hidden = new Map;
  const sent = new Map;
  claude.store.get(hiddenKey).then((saved) => {
    if (typeof saved !== "object" || saved === null)
      return;
    for (const [id, hides] of Object.entries(saved))
      if (typeof hides === "string" && !hidden.has(id))
        hidden.set(id, hides);
  }, (error) => warn("hidden:read", `${name}: could not read the failures you hid: ${messageOf(error)}`));
  let lastId = 0;
  let frame = 0;
  let spinning;
  let isHeld = false;
  let showsAll = false;
  let bandId;
  const isLoading = (entry) => entry.type === "loading" || entry.trying !== undefined;
  const isSpinning = (entry) => entry.spinsFrom !== undefined && frame - entry.spinsFrom < spinFrames;
  const changed = () => {
    for (const entry of entries.values())
      entry.spinsFrom = isLoading(entry) ? entry.spinsFrom ?? frame : undefined;
    const spins = [...entries.values()].some(isSpinning);
    if (spins && spinning === undefined) {
      spinning = claude.clock.every(spinnerMs, () => {
        frame += 1;
        changed();
      });
    }
    if (!spins && spinning !== undefined) {
      spinning.cancel();
      spinning = undefined;
    }
    if (entries.size <= visibleToasts)
      showsAll = false;
    claude.ui.invalidate("ui.render");
  };
  const disarm = (entry) => {
    entry.timer?.cancel();
    entry.timer = undefined;
  };
  const arm = (entry) => {
    const duration = entry.options.duration ?? defaultDuration;
    if (entry.timer !== undefined || entry.type === "loading" || entry.isOpen || !Number.isFinite(duration))
      return;
    entry.timer = claude.clock.after(duration, () => {
      entry.timer = undefined;
      if (isHeld)
        arm(entry);
      else
        dismiss(entry.id);
    });
  };
  const dismiss = (id) => {
    if (id === undefined)
      sent.clear();
    else
      sent.delete(String(id));
    for (const entry of entries.values()) {
      if (id !== undefined && entry.id !== id && !entry.merged.has(String(id)))
        continue;
      for (const merged of entry.merged.keys())
        sent.delete(merged);
      disarm(entry);
      entries.delete(entry.id);
    }
    changed();
  };
  const put = (type, message, options, actions, hides) => {
    const id = options.id ?? (lastId += 1);
    const previous = entries.get(id);
    if (previous?.trying !== undefined && type === "loading") {
      previous.trying = options.description ?? message;
      changed();
      return id;
    }
    if (previous !== undefined)
      disarm(previous);
    const reporting = hides !== undefined && previous?.hides === hides ? previous.reporting : undefined;
    const entry = { id, type, message, options, actions, ...hides === undefined ? {} : { hides }, merged: new Map, count: 1, at: new Date, isOpen: previous?.isOpen ?? false, reporting, timer: undefined };
    if (type === "error" && previous?.message !== message)
      claude.ui.log(`${name}: ${message}${typeof options.description === "string" ? `: ${options.description}` : ""}`, { to: "debug" });
    entries.set(id, entry);
    changed();
    return id;
  };
  const show = (type) => (message, options = {}) => put(type, message, options, options.action === undefined ? [] : [options.action]);
  const hide = (entry) => {
    dismiss(entry.id);
    if (entry.hides === undefined)
      return;
    for (const [id, hides] of [[String(entry.id), entry.hides], ...entry.merged])
      hidden.set(id, hides);
    claude.store.set(hiddenKey, Object.fromEntries(hidden)).catch((error) => warn("hidden:write", `${name}: could not remember the failure you hid: ${messageOf(error)}`));
  };
  const toast = Object.assign(show("default"), {
    success: show("success"),
    info: show("info"),
    warning: show("warning"),
    error: show("error"),
    loading: show("loading"),
    dismiss,
    promise(task, messages) {
      const id = show("loading")(messages.loading);
      const settled = Promise.resolve().then(() => typeof task === "function" ? task() : task).then((value) => {
        show("success")(typeof messages.success === "function" ? messages.success(value) : messages.success, { id });
        return value;
      }, (error) => {
        show("error")(typeof messages.error === "function" ? messages.error(error) : messages.error, { id });
        throw error;
      });
      settled.catch(() => {
        return;
      });
      return { unwrap: () => settled };
    }
  });
  const copy = async (text) => {
    const copied = await claude.ui.copy({ text });
    if (!copied.isCopied)
      throw new Error(copied.reason);
  };
  const press = (entry, run) => () => void Promise.resolve().then(run).catch((error) => fail({ id: `press:${entry.id}`, message: `${entry.message}: the press failed`, error, isCritical: true }));
  const logFailure = (failure) => claude.cmod.call({ to: cmodPluginName, method: failedMethod, input: failure });
  const modVersion = () => claude.fs.read(`${claude.plugin.root}/.claude-plugin/plugin.json`).then((text) => String(JSON.parse(text).version)).catch((failure) => `unknown (${messageOf(failure)})`);
  const detailsOf = (version, at, text) => `${name} ${version}, @cmodjs/core ${coreVersion}, at ${at.toISOString()}
${text}`;
  const warned = new Map;
  const warn = (id, text) => {
    claude.ui.log(text, { to: "debug" });
    const at = new Date;
    const repeat = `${text}
${at.toISOString().slice(0, 16)}`;
    if (warned.get(id) === repeat)
      return;
    warned.set(id, repeat);
    claude.clock.after(0, () => {
      (async () => {
        const version = await modVersion();
        await logFailure({ mod: name, id, message: text, details: detailsOf(version, at, text), at: at.toISOString(), isCritical: false, root: claude.plugin.root, level: "warning", version, core: coreVersion });
      })().catch(() => {
        return;
      });
    });
  };
  const showsToast = async (failure, isShown) => {
    const call = { isSettled: false };
    try {
      const logged = logFailure(failure).finally(() => void (call.isSettled = true));
      const answer = await (isShown ? logged : beforeDeadline(claude.clock, { ms: failedCallMs }, failedMethod, () => logged));
      if (isObject(answer) && typeof answer["showsToast"] === "boolean")
        return answer["showsToast"];
      throw new Error(`cmod answered ${answer === undefined ? "nothing" : JSON.stringify(answer)}, not { showsToast: true or false }`);
    } catch (error) {
      if (!call.isSettled || isUnanswered(error))
        return "unanswered";
      claude.ui.log(`${name}: cmod kept no Log of ${failure.id}, so it shows the toast: ${messageOf(error)}`, { to: "debug" });
      return;
    }
  };
  const fail = ({ id, message, error, description = error === undefined || describe(error) === message ? undefined : describe(error), retry, isCritical = false, root = claude.plugin.root }) => {
    if (!isCritical && isUnanswered(error)) {
      warn(id, `${name}: ${message}: ${describe(error)}`);
      return id;
    }
    const hides = `${version() ?? ""}
${message}
${error === undefined ? "" : describe(error)}`;
    const at = new Date;
    const repeat = `${hides}
${description ?? ""}
${at.toISOString().slice(0, 16)}`;
    if (sent.get(id) === repeat)
      return id;
    sent.set(id, repeat);
    const stack = error instanceof Error && error.stack !== undefined ? `

${error.stack}` : "";
    const details = async (failedAt) => detailsOf(await modVersion(), failedAt, `${message}${description === undefined ? "" : `
${description}`}${stack}`);
    const logged = async (tries = 0) => {
      const contact = await contactOf(claude);
      const version = await modVersion();
      const failure = { mod: name, id, message, details: detailsOf(version, at, `${message}${description === undefined ? "" : `
${description}`}${stack}`), at: at.toISOString(), isCritical, root, ...contact === undefined ? {} : { contact }, level: "error", version, core: coreVersion };
      const shows = await showsToast(failure, isCritical);
      const wait = logAgainMs[tries];
      if (shows === "unanswered" && wait !== undefined)
        return void claude.clock.after(wait, () => void logged(tries + 1));
      if (shows === "unanswered")
        claude.ui.log(`${name}: cmod did not answer ${logAgainMs.length + 1} times, so ${id} reached no Log and shows its toast`, { to: "debug" });
      if (isCritical)
        return;
      if (shows !== false)
        return show();
      claude.ui.log(`${name}: ${message}${description === undefined ? "" : `: ${description}`}`, { to: "debug" });
    };
    const show = () => {
      if (hidden.get(id) === hides)
        return;
      hidden.delete(id);
      const own = entries.get(id);
      const text = description ?? message;
      const shown = own === undefined ? [...entries.values()].find((entry) => entry.hides !== undefined && entry.trying === undefined && (entry.options.description ?? entry.message) === text) : own.hides === hides && own.trying === undefined && own.options.description === description ? own : undefined;
      if (shown !== undefined) {
        if (shown !== own)
          shown.merged.set(id, hides);
        shown.count += 1;
        shown.at = new Date;
        changed();
        return;
      }
      const actions = [{ label: "Report", onClick: startReporting }, ...retry === undefined ? [] : [{ label: "Retry", onClick: tryAgain }], ...fixes];
      put("error", message, { id, ...description === undefined ? {} : { description }, duration: Infinity }, actions, hides);
    };
    const startReporting = async () => {
      const shown = entries.get(id);
      if (shown === undefined)
        return;
      shown.reporting = { contact: await contactOf(claude), details: await details(shown.at) };
      disarm(shown);
      changed();
      if (bandId === undefined)
        return;
      const focused = await claude.ui.focus({ requestId: bandId, key: `toast:${id}:ask-claude` });
      if ("deny" in focused)
        warn("report:focus", `${name}: the Report choices did not take the keys: ${String(focused.deny)}`);
    };
    const tryAgain = async () => {
      const shown = entries.get(id);
      if (shown === undefined || retry === undefined || shown.trying !== undefined)
        return;
      shown.trying = "Starting";
      changed();
      try {
        await retry();
      } finally {
        if (entries.get(id) === shown) {
          shown.trying = undefined;
          changed();
        }
      }
    };
    const fixes = [
      { sentence: installFix, label: "Plugins", onClick: () => claude.command.run({ command: "plugin" }) },
      { sentence: secretFix, label: "Open /config", onClick: () => claude.command.run({ command: "config" }) }
    ].filter(({ sentence }) => `${message}
${description ?? ""}`.includes(sentence));
    if (isCritical)
      show();
    claude.clock.after(0, () => void logged());
    return id;
  };
  const toggle = (entry) => () => {
    entry.isOpen = !entry.isOpen;
    disarm(entry);
    changed();
  };
  const row = (entry, columns) => {
    const { description } = entry.options;
    const isText = typeof description === "string";
    const icon = entry.type === "loading" || entry.trying !== undefined ? { glyph: isSpinning(entry) ? spinner[frame % spinner.length] : still, color: "claude" } : icons[entry.type];
    const message = isText ? Button({ plain: true, key: `toast:${entry.id}:open`, label: entry.message, onPress: toggle(entry) }) : Text({ children: entry.message });
    const details = !isText ? description : Text({ dimColor: true, wrap: entry.isOpen ? "wrap" : "truncate-end", children: entry.isOpen ? description : firstLine(description) });
    const fixed = (child) => Box({ flexShrink: 0, children: child });
    const close = Button({ plain: true, dimColor: true, key: `toast:${entry.id}:close`, label: "✕", onPress: () => hide(entry) });
    const actions = entry.actions.map((action, index) => Button({ plain: true, key: `toast:${entry.id}:${index === 0 ? "action" : `action-${index}`}`, label: action.label, onPress: press(entry, action.onClick) }));
    const time = Text({ dimColor: true, children: entry.count > 1 ? `${clockTime(entry.at)} · ${entry.count} times` : clockTime(entry.at) });
    const buttons = actions.length === 0 ? [] : [Box({ gap: columnGap, flexWrap: "wrap", children: [...actions, time].map(fixed) })];
    const trying = entry.trying === undefined ? undefined : Box({ gap: 1, children: [Text({ dimColor: true, children: "Trying again:" }), typeof entry.trying === "string" ? Text({ dimColor: true, wrap: "truncate-end", children: entry.trying }) : entry.trying] });
    const text = details === undefined ? [] : [trying ?? details];
    const under = trying !== undefined && details === undefined ? [trying] : entry.reporting === undefined ? buttons : reportChoices(entry, entry.reporting);
    return Box({
      width: columns,
      gap: columnGap,
      justifyContent: "space-between",
      children: [
        Box({
          gap: columnGap,
          flexShrink: 1,
          children: [
            fixed(Text({ ...icon.color === undefined ? {} : { color: icon.color }, children: icon.glyph })),
            fixed(Text({ dimColor: true, children: name.padEnd(nameColumn) })),
            Box({ flexDirection: "column", flexShrink: 1, children: [message, ...text, ...under] })
          ]
        }),
        fixed(close)
      ]
    });
  };
  const reportChoices = (entry, { contact, details, status }) => {
    const say = (said) => {
      entry.reporting = { contact, details, status: said };
      changed();
    };
    const back = () => {
      entry.reporting = undefined;
      changed();
    };
    const askClaude = async () => {
      await claude.prompt.submit({ text: reportPrompt(name, contact, details), asUser: true });
      back();
    };
    const copyError = async () => {
      const copied = await claude.ui.copy({ text: details });
      say(copied.isCopied ? "Copied the error." : `Could not copy it: ${copied.reason}`);
    };
    const report = contact === undefined ? [] : [reportLink(`toast:${entry.id}:report`, contact, name, entry.message, details)];
    return [
      Text({ dimColor: true, children: "Claude writes up the problem and files it with your tools. You approve each step before anything is posted." }),
      Box({
        gap: 2,
        flexWrap: "wrap",
        children: [
          Button({ plain: true, key: `toast:${entry.id}:ask-claude`, label: "Ask Claude to report it", onPress: press(entry, askClaude) }),
          ...report,
          Button({ plain: true, key: `toast:${entry.id}:copy`, label: "Copy the error", onPress: press(entry, copyError) }),
          Button({ plain: true, dimColor: true, key: `toast:${entry.id}:back`, label: "Back", onPress: back })
        ]
      }),
      ...status === undefined ? [] : [Text({ dimColor: true, children: status })]
    ];
  };
  return {
    toast,
    copy,
    fail,
    warn,
    get shown() {
      return [...entries.values()].map(({ type, message, options }) => ({ type, message, ...typeof options.description === "string" ? { description: options.description } : {} }));
    },
    draw(drawn, table, band, drawnIn) {
      bandId = drawnIn;
      isHeld = band.hasSurvey === true;
      if (isHeld || entries.size === 0)
        return drawn;
      const all = [...entries.values()];
      const hidden = showsAll ? 0 : Math.max(all.length - visibleToasts, 0);
      for (const entry of all.slice(hidden))
        arm(entry);
      const more = Button({
        plain: true,
        dimColor: true,
        key: "toasts:more",
        label: `+${hidden} more`,
        onPress: () => {
          showsAll = true;
          changed();
        }
      });
      return drawWith(table, () => Box({ flexDirection: "column", children: [drawn, ...hidden > 0 ? [more] : [], ...all.slice(hidden).map((entry) => row(entry, band.bodyColumns))] }));
    }
  };
}
function describe(error) {
  const messages = [];
  for (let cause = error;cause !== undefined; cause = cause instanceof Error ? cause.cause : undefined) {
    const text = messageOf(cause);
    if (!messages.some((earlier) => earlier.includes(text) || text.includes(earlier)))
      messages.push(text);
  }
  return messages.join(`
`);
}
async function contactOf(claude) {
  const manifest = await claude.fs.read(`${claude.plugin.root}/.claude-plugin/plugin.json`).then((text) => JSON.parse(text)).catch((error) => {
    claude.ui.log(`${claude.plugin.name}: could not read whom to report to: ${messageOf(error)}`, { to: "debug" });
    return {};
  });
  const repositoryUrl = isObject(manifest["repository"]) ? manifest["repository"]["url"] : manifest["repository"];
  const repository = [manifest["supportUrl"], repositoryUrl].map((url) => typeof url === "string" ? githubRepository.exec(url)?.[1] : undefined).find((found) => found !== undefined);
  if (repository !== undefined)
    return { kind: "github", repository };
  const author = manifest["author"];
  const address = isObject(author) ? author["email"] : undefined;
  return typeof address === "string" && address !== "" ? { kind: "email", address } : undefined;
}
function reportLink(key, contact, name, message, details) {
  const title = `${name}: ${message}`.slice(0, 120);
  const linkOf = (body) => contact.kind === "github" ? `https://github.com/${contact.repository}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}` : `mailto:${contact.address}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  let body = details;
  while (linkOf(body).length > linkLimit && body.length > 0)
    body = `${body.slice(0, Math.floor(body.length * 0.8))}…`;
  return Button({ plain: true, key, href: linkOf(body), label: contact.kind === "github" ? "Report it on GitHub (opens your browser)" : "Email the author (opens your mail app)" });
}
function reportPrompt(name, contact, details) {
  const where = contact === undefined ? `${name} names no place to report it, so find its author from its plugin.json or its marketplace.` : contact.kind === "github" ? `Report it as an issue on https://github.com/${contact.repository}.` : `Email it to ${contact.address}.`;
  return `The ${name} mod failed. Report it to its author. ${where} First check whether it is reported already, and add to that report instead of filing a new one. Show me the report before you post it.

${details}`;
}
function clockTime(at) {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// node_modules/@cmodjs/core/runtime/hotkeys.js
async function readCombos(claude, configRoot) {
  if (configRoot === undefined)
    return new Map;
  const text = await claude.fs.read(`${configRoot}/keybindings.json`).catch(ifMissing("{}"));
  try {
    return boundCombos(JSON.parse(text));
  } catch (error) {
    claude.ui.warn("hotkeys:read", `${configRoot}/keybindings.json is not JSON, so cmod reads no combos from it: ${messageOf(error)}`);
    return new Map;
  }
}
async function createHotkeys({ name, declared, configRoot, claude, router, answerInput, report }) {
  if (name === cmodPluginName) {
    router.add("command.describe", async (e, next) => {
      const described = await next(e);
      return e.command.startsWith(hotkeyCommand(e.provider.plugin.replace(/@[^@]*$/, ""), "")) ? { ...described, isHidden: true } : described;
    });
  }
  const entries = Object.entries(declared);
  if (entries.length === 0)
    return {};
  const combos = await readCombos(claude, configRoot);
  const listeners = new Map;
  const commands = new Map;
  for (const [hotkey, { title }] of entries) {
    listeners.set(hotkey, new Set);
    claude.command.register({ name: hotkeyCommand(name, hotkey), description: title, immediate: true }).then(({ command }) => void commands.set(command, hotkey), (error) => report({ id: `hotkey:${hotkey}`, message: `The ${title} hotkey is not added`, error }));
  }
  router.add("command.run", async (e, next) => {
    const hotkey = commands.get(e.command);
    if (hotkey === undefined)
      return next(e);
    return answerInput(async () => {
      for (const listener of listeners.get(hotkey) ?? []) {
        try {
          await listener();
        } catch (error) {
          report({ id: `hotkey:${hotkey}`, message: `The ${declared[hotkey]?.title ?? hotkey} hotkey failed`, error, isCritical: true });
        }
      }
      return {};
    }, () => next(e));
  });
  return Object.fromEntries(entries.map(([hotkey, { title }]) => [
    hotkey,
    {
      title,
      combo: combos.get(hotkeyCommand(name, hotkey)),
      onPress(listener) {
        listeners.get(hotkey)?.add(listener);
        return { remove: () => void listeners.get(hotkey)?.delete(listener) };
      }
    }
  ]));
}

// node_modules/@cmodjs/core/runtime/parts.js
var keptDrawings = 200;
function drawnParts({ claude, report, press }) {
  const drawn = new Map;
  const drawing = new Map;
  const generations = new Map;
  const keyOf = (mod, cached) => `${mod}\x00${cached}`;
  const generationOf = (mod) => generations.get(mod) ?? 0;
  return {
    fill(mod, cached, input, name) {
      const key = keyOf(mod, cached);
      const generation = generationOf(mod);
      if (drawn.get(key)?.generation === generation)
        return;
      const keep = (data, failure) => {
        drawn.delete(key);
        drawn.set(key, { data, ...failure === undefined ? {} : { failure }, generation });
        const [oldest] = drawn.keys();
        if (drawn.size > keptDrawings && oldest !== undefined)
          drawn.delete(oldest);
        if (generationOf(mod) !== generation)
          claude.ui.invalidate("ui.render");
      };
      const pending = drawing.get(key) ?? claude.cmod.call({ to: mod, method: partMethods.draw, input }).then((data) => keep(data ?? null), (error) => {
        if (isStillInstalling(mod, error))
          return keep(drawn.get(key)?.data ?? null);
        report(`draw:${mod}`, `${name} drew nothing`, error);
        keep(drawn.get(key)?.data ?? null, messageOf(error));
      }).finally(() => drawing.delete(key));
      drawing.set(key, pending);
      return pending;
    },
    element(mod, cached, keyPrefix, name, reportId) {
      const key = keyOf(mod, cached);
      const entry = drawn.get(key);
      if (entry === undefined)
        return;
      drawn.delete(key);
      drawn.set(key, entry);
      const { data } = entry;
      if (data === null || data.tree === null)
        return;
      try {
        return elementOf(data.tree, keyPrefix, (handler, args) => press(mod, { draw: data.draw, handler, args }));
      } catch (error) {
        report(reportId, `${name} could not draw`, error);
        return;
      }
    },
    failure(mod, cached) {
      return drawn.get(keyOf(mod, cached))?.failure;
    },
    forget(mod) {
      generations.set(mod, generationOf(mod) + 1);
    }
  };
}

// node_modules/@cmodjs/core/runtime/watches.js
var watchMs = 500;
var missingEvery = 4;
var watchedFiles = 2000;
function createWatches(claude, report) {
  const watches = new Set;
  let polling;
  let isPolling = false;
  let ticks = 0;
  const stampsOf = async (watch) => {
    const { paths } = watch;
    const stamps = new Map;
    const missing = new Set;
    const skipped = ticks % missingEvery === 0 ? new Set : watch.missing;
    const visit = async (path) => {
      const stat = await claude.fs.stat(path).catch(ifMissing(undefined));
      if (stat === undefined)
        return;
      if (stat.kind !== "dir") {
        if (stamps.size === watchedFiles)
          throw new Error(`fs.onChange watches at most ${watchedFiles} files, and ${paths.join(", ")} holds more, so it stopped. Watch a smaller folder.`);
        return void stamps.set(path, stat.mtimeMs);
      }
      for (const entry of await claude.fs.list(path).catch(ifMissing([])))
        await visit(`${path}/${entry.name}`);
    };
    for (const path of paths) {
      if (skipped.has(path)) {
        missing.add(path);
        continue;
      }
      await visit(path);
      if (![...stamps.keys()].some((seen) => seen === path || seen.startsWith(`${path}/`)))
        missing.add(path);
    }
    watch.missing = missing;
    return stamps;
  };
  const stop = (watch) => {
    watches.delete(watch);
    if (watches.size > 0)
      return;
    polling?.cancel();
    polling = undefined;
  };
  const stampsOrStop = (watch) => stampsOf(watch).catch((error) => {
    stop(watch);
    report({ id: "fs:onChange", message: "Could not read the files fs.onChange watches", error });
    return;
  });
  const poll = async () => {
    if (isPolling)
      return;
    isPolling = true;
    ticks += 1;
    try {
      for (const watch of watches) {
        const now = await stampsOrStop(watch);
        if (now === undefined)
          continue;
        const before = watch.seen;
        watch.seen = now;
        if (before === undefined)
          continue;
        const changes = [
          ...[...now].filter(([path, at]) => before.has(path) && before.get(path) !== at).map(([path]) => ({ path, type: "change" })),
          ...[...now.keys()].filter((path) => !before.has(path)).map((path) => ({ path, type: "add" })),
          ...[...before.keys()].filter((path) => !now.has(path)).map((path) => ({ path, type: "unlink" }))
        ];
        for (const change of changes)
          await Promise.resolve().then(() => watch.listener(change)).catch((error) => report({ id: "fs:onChange", message: "The fs.onChange listener failed", error }));
      }
    } finally {
      isPolling = false;
    }
  };
  return {
    add(paths, listener) {
      const watch = { paths, listener, seen: undefined, missing: new Set };
      watches.add(watch);
      stampsOrStop(watch).then((stamps) => void (watch.seen ??= stamps));
      polling ??= claude.clock.every(watchMs, () => void poll());
      return { remove: () => stop(watch) };
    }
  };
}

// node_modules/@cmodjs/core/ui/components.js
var toneColors = { neutral: undefined, info: "suggestion", success: "success", warning: "warning", critical: "error" };
var textOf2 = (tone) => {
  const color = toneColors[tone];
  return color === undefined ? { dimColor: true } : { color };
};
var Tabs = hostComponent("Tabs", ({ tabs, selected, onSelect, children }) => ({
  key: "",
  tabs: tabs.map(({ key, label, hotkey }) => ({ key, label, ...hotkey === undefined ? {} : { hotkey }, isSelected: key === selected, onSelect: () => onSelect(key) })),
  ...children === undefined ? {} : { children }
}), ({ key: prefix, tabs, children }) => {
  const row = tabs.map(({ key, label, hotkey, isSelected, onSelect }) => isSelected ? Text({ children: [...hotkey === undefined ? [] : [Text({ color: "claude", children: hotkey }), ": "], Text({ bold: true, underline: true, children: label })] }) : Button({ plain: true, dimColor: true, key: `${prefix}tab:${key}`, ...hotkey === undefined ? {} : { hotkey }, label, onPress: onSelect }));
  return Box({ flexDirection: "column", gap: 1, children: [Box({ gap: 3, children: row }), children] });
});
var Split = hostComponent("Split", ({ children }) => ({ children }), ({ children }) => {
  const width = `${Math.floor(100 / Math.max(children.length, 1))}%`;
  return Box({ gap: 1, children: children.map((child) => Box({ width, children: child })) });
});
var Panel = hostComponent("Panel", ({ title, description, actions, children }) => ({ title, ...description === undefined ? {} : { description }, ...actions === undefined ? {} : { actions }, ...children === undefined ? {} : { children } }), ({ title, description, actions, children }) => {
  const header = description === undefined && actions === undefined ? [] : [Box({ justifyContent: "space-between", columnGap: 2, flexWrap: "wrap", children: [Text({ dimColor: true, wrap: "wrap", children: description ?? "" }), ...actions === undefined ? [] : [Box({ gap: 2, flexShrink: 0, children: actions })]] })];
  return Box({
    flexDirection: "column",
    flexGrow: 1,
    children: [
      Box({ flexDirection: "column", flexGrow: 1, gap: header.length === 0 ? 0 : 1, minWidth: [...title].length + 6, borderStyle: "round", borderColor: "subtle", paddingX: 1, children: [...header, children] }),
      Box({ position: "absolute", top: 0, left: 2, children: Text({ bold: true, wrap: "truncate-end", children: ` ${title} ` }) })
    ]
  });
});
var Toggle = hostComponent("Toggle", ({ label, checked, onChange }) => ({ key: "", label, checked, onToggle: () => onChange(!checked) }), ({ key, label, checked, onToggle }) => Button({ plain: true, key: `${key}toggle:${label}`, label: `${checked ? "[x]" : "[ ]"} ${label}`, onPress: onToggle }));
var cardColumns = 36;
function card(text, isShown) {
  return Box({
    position: "absolute",
    bottom: 1,
    left: 0,
    width: Math.min(text.length + 2, cardColumns),
    ...isShown ? {} : { display: "none", hover: { display: "flex" } },
    backgroundColor: "text",
    paddingX: 1,
    children: Text({ color: "inverseText", wrap: "wrap", children: text })
  });
}
var Tooltip = hostComponent("Tooltip", ({ text, children }) => ({ key: "", text, ...children === undefined ? {} : { children } }), ({ key, text, children }) => Box({ key: `${key}tooltip:${text}`, children: [children, card(text, false)] }));
var Help = hostComponent("Help", ({ text, isOpen, onOpenChange }) => ({ key: "", text, isOpen, onToggle: () => onOpenChange(!isOpen) }), ({ key, text, isOpen, onToggle }) => Box({ key: `${key}help:${text}`, children: [Button({ plain: true, key: `${key}help-button:${text}`, label: "?", onPress: onToggle }), card(text, isOpen)] }));
var Dialog = hostComponent("Dialog", ({ title, children, actions }) => ({ title, actions, ...children === undefined ? {} : { children } }), ({ title, children, actions }) => Box({ flexDirection: "column", gap: 1, paddingX: 1, children: [Text({ bold: true, children: title }), children, Box({ gap: 2, children: actions })] }));
var Pagination = hostComponent("Pagination", ({ page, pages, onPage }) => ({
  page,
  pages,
  ...page > 1 ? { onPrevious: () => onPage(page - 1) } : {},
  ...page < pages ? { onNext: () => onPage(page + 1) } : {}
}), ({ page, pages, onPrevious, onNext }) => Box({
  gap: 2,
  children: [
    onPrevious === undefined ? Text({ dimColor: true, children: "p: Previous" }) : Button({ plain: true, hotkey: "p", label: "Previous", onPress: onPrevious }),
    Text({ dimColor: true, children: `${page} of ${pages}` }),
    onNext === undefined ? Text({ dimColor: true, children: "n: Next" }) : Button({ plain: true, hotkey: "n", label: "Next", onPress: onNext })
  ]
}));
var eighths = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
var roundedLeft = "";
var roundedRight = "";
var barColors = { neutral: "inactive", info: "suggestion", success: "success", warning: "warning", critical: "error" };
function filledSections(sections) {
  let reached = 0;
  return sections.map((section) => {
    const filled = Math.min(Math.max(section.value, 0), 100 - reached);
    reached += filled;
    return { ...section, value: filled };
  });
}
var Progress = hostComponent("Progress", ({ width = 24, label, buffer, ...given }) => {
  const sections = "sections" in given ? filledSections(given.sections) : given.tone === undefined ? undefined : filledSections([given]);
  const value = sections === undefined && "value" in given ? Math.min(Math.max(given.value, 0), 100) : (sections ?? []).reduce((sum, each) => sum + each.value, 0);
  const buffered = buffer === undefined ? undefined : Math.min(Math.max(buffer, value), 100);
  return { value, width, ...label === undefined ? {} : { label }, ...sections === undefined ? {} : { sections }, ...buffered === undefined || buffered === value ? {} : { buffer: buffered } };
}, ({ value, width, sections, buffer }) => {
  const isRounded = drawnIn().hasNerdFont && width > 2;
  const cells = isRounded ? width - 2 : width;
  const units = cells * eighths.length;
  let reached = 0;
  const ends = (sections ?? [{ value }]).map((section) => {
    reached += section.value;
    return { end: Math.round(reached / 100 * units), color: "color" in section ? section.color : section.tone === undefined ? "claude" : barColors[section.tone] };
  });
  const buffered = Math.round((buffer ?? 0) / 100 * units);
  const colorAt = (unit) => ends.find(({ end }) => unit < end)?.color ?? (unit < buffered ? "promptBorder" : "subtle");
  const drawn = [];
  for (let cell = 0;cell < cells; cell++) {
    const from = cell * eighths.length;
    const left = colorAt(from);
    const right = colorAt(from + eighths.length - 1);
    let edge = 1;
    while (edge < eighths.length && colorAt(from + edge) === left)
      edge++;
    drawn.push(left === right ? { color: left, children: "█" } : { color: left, backgroundColor: right, children: eighths[edge] ?? "█" });
  }
  const capped = isRounded ? [{ color: colorAt(0), children: roundedLeft }, ...drawn, { color: colorAt(units - 1), children: roundedRight }] : drawn;
  return Text({ children: runsOf(capped).map((run) => Text(run)) });
});
function runsOf(cells) {
  const runs = [];
  for (const cell of cells) {
    const last = runs.at(-1);
    if (last !== undefined && last.color === cell.color && last.backgroundColor === cell.backgroundColor && last.children !== roundedLeft && cell.children !== roundedRight)
      last.children += cell.children;
    else
      runs.push({ ...cell });
  }
  return runs;
}
var List = hostComponent("List", ({ label, children }) => ({ label, ...children === undefined ? {} : { children } }), ({ children }) => Box({ flexDirection: "column", children }));
var statusOf = (tone) => tone === undefined ? [] : [tone === "off" ? Text({ dimColor: true, children: "○ " }) : Text({ ...textOf2(tone), children: "● " })];
function treeRow({ key, label, description, leading, trailing, tone, isSelected, depth = 0, isOpen, onToggle, onPress }) {
  const opener = isOpen !== undefined && onToggle !== undefined ? Button({ plain: true, key: `${key}:toggle`, onPress: onToggle, children: Text({ dimColor: true, children: isOpen ? "▾" : "▸" }) }) : Text({ children: " " });
  const shown = Text({ wrap: "truncate-end", ...isSelected === true ? { bold: true } : {}, children: [...statusOf(tone), ...leading === undefined ? [] : [Text({ dimColor: true, children: `${leading} ` })], label] });
  const row = Box({ columnGap: 1, minWidth: 0, children: [opener, onPress === undefined ? shown : Button({ plain: true, key, onPress, children: shown })] });
  const end = [...description === undefined ? [] : [Text({ dimColor: true, children: description })], ...trailing === undefined ? [] : [trailing]];
  if (end.length === 0)
    return Box({ paddingLeft: depth * 2, children: row });
  return Box({ width: "100%", paddingLeft: depth * 2, columnGap: 1, justifyContent: "space-between", children: [row, Box({ flexShrink: 0, columnGap: 1, children: end })] });
}
var ListItem = hostComponent("ListItem", ({ onOpenChange, ...props }) => ({ ...props, ...onOpenChange === undefined || props.isOpen === undefined ? {} : { onToggle: () => onOpenChange(props.isOpen !== true) } }), (props) => {
  const { key, label, description, leading, trailing, tone, isSelected, depth, onPress } = props;
  if (depth !== undefined)
    return treeRow(props);
  const shown = [...statusOf(tone), ...leading === undefined ? [] : [Text({ dimColor: true, children: `${leading} ` })], label, ...description === undefined ? [] : [Text({ dimColor: true, children: ` ${description}` })], ...trailing === undefined ? [] : [" ", trailing]];
  if (isSelected === true || onPress === undefined)
    return Box({ ...isSelected === true ? { backgroundColor: "userMessageBackground" } : {}, paddingX: 1, children: Text({ wrap: "truncate-end", ...isSelected === true ? { bold: true } : {}, children: shown }) });
  return Box({ paddingX: 1, children: Button({ plain: true, dimColor: true, key, onPress, children: shown }) });
});
var Badge = hostComponent("Badge", ({ tone = "neutral", children }) => ({ tone, children }), ({ tone, children }) => Text({ ...textOf2(tone), children }));
var wordsOf = (children) => {
  const all = [children].flat(Infinity).filter((each) => each !== null && each !== undefined && typeof each !== "boolean");
  return all.every((each) => typeof each === "string" || typeof each === "number") ? all.join("") : undefined;
};
var Banner = hostComponent("Banner", ({ tone = "info", title, children, actions }) => ({ tone, ...title === undefined ? {} : { title }, ...children === undefined ? {} : { children }, ...actions === undefined ? {} : { actions } }), ({ tone, title, children, actions }) => Box({
  flexDirection: "column",
  children: [
    ...title === undefined ? [] : [Text({ ...textOf2(tone), bold: true, wrap: "wrap", children: title })],
    ...children === undefined ? [] : [wordsOf(children) === undefined ? children : Text({ ...title === undefined ? textOf2(tone) : {}, wrap: "wrap", children: wordsOf(children) })],
    ...actions === undefined ? [] : [Box({ gap: 2, flexShrink: 0, children: actions })]
  ]
}));

// node_modules/@cmodjs/core/runtime/lifecycle.js
var listenMethods = [conversationMethods.subscribe, conversationMethods.watchBefore];
var answeredAtOnce = [...listenMethods, partMethods.draw];
var announcedKey = "cmod:announced";
var cmodUpdatedKey = "cmod:cmod-updated-for";
var installId = "cmod:install";
var askingId = "cmod:asking";
var recordId = "cmod:record";
var downloadId = "cmod:download";
var installRetrySeconds = [2, 4, 8, 16, 32, 64, 128];
var cmodCheckMs = 1000;
var recordCheckMs = 1000;
var drawsPerMs = 1000;
var cmodWaitMs = 60000;
var cmodSlowCheckMs = 1e4;
var startHoldMs = hookMs / 2;
var stallTicks = 3;
var stallMs = 60000;
var settingsLoadMs = 500;
var shellTools = ["Bash", "PowerShell"];
async function roundsBarEnds(claude) {
  const path = preferencesPath(await cmodStore(claude));
  const text = await claude.fs.read(path).catch(ifMissing(undefined));
  return parsePreferences(text === undefined ? undefined : JSON.parse(text), path).roundsBarEnds;
}
async function readPlugin(claude) {
  const { name, root } = claude.plugin;
  const read = async (path) => {
    const stat = await claude.fs.stat(path).catch(ifMissing(undefined));
    return stat?.kind === "file" ? claude.fs.read(path) : undefined;
  };
  const manifest = await readJson(read, `${root}/.claude-plugin/plugin.json`);
  const version = typeof manifest?.version === "string" ? manifest.version : undefined;
  const store = await cmodStore(claude);
  const steps = readSteps(await readJson(read, `${root}/package.json`)) ?? {};
  if (name === cmodPluginName) {
    const installed = await newestCmodVersion(claude);
    return { name, root, version, store, steps, isInstalled: version !== undefined && installed !== undefined && isAtLeast(installed, version), shouldRecord: false };
  }
  const plugin = { name, root, version, store, steps };
  const record = await readRecord(read, store, name);
  if (Object.keys(steps).length === 0)
    return { ...plugin, isInstalled: true, shouldRecord: record?.version !== version };
  const scripts = await scriptsSha256(steps, {
    read: (path) => read(`${root}/${path}`),
    list: (folder) => filesBelow(claude, `${root}/${folder}`)
  });
  if (version === undefined || record?.scriptsSha256 !== scripts)
    return { ...plugin, isInstalled: false, shouldRecord: false };
  const isInstalled = record.version === version || record.root === root;
  const modifiedMs = await programModifiedMs(async (path) => (await claude.fs.stat(path).catch(ifMissing(undefined)))?.mtimeMs, store, record);
  return { ...plugin, isInstalled, shouldRecord: isInstalled && (record.version !== version || isProgramNewer(record, modifiedMs)) };
}
async function filesBelow(claude, folder) {
  const entries = await claude.fs.list(folder);
  const paths = await Promise.all(entries.map(async ({ name, kind, isLink }) => {
    if (kind === "file" || isLink)
      return [name];
    if (kind === "dir")
      return (await filesBelow(claude, `${folder}/${name}`)).map((path) => `${name}/${path}`);
    return [];
  }));
  return paths.flat();
}
async function readJson(read, path) {
  const text = await read(path);
  if (text === undefined)
    return;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON (${messageOf(error)}). Fix it, then press Retry.`);
  }
}
function createLifecycle(definition, permissionRoutes = () => {
  return;
}, options = {}, asksPerson = true, serveCmodPlugin) {
  let router = createRouter();
  let startingRouter;
  let phase = "starting";
  let runtime;
  let programs;
  let plugin;
  let activation;
  let mod;
  const openSettings = async () => {
    await claude().cmod.call({ to: cmodPluginName, method: partMethods.changed, input: { requests: [{ settings: true }], isAsked: true } });
  };
  let imports;
  let raise;
  let settingsLoaded;
  let failure;
  let pluginOptions = options;
  let drawCount = 0;
  const nextDraw = () => drawCount += 1;
  const installer = createInstaller(definition.name, () => claude(), {
    show: (open, next) => {
      if (phase !== "active")
        runtime?.toaster.toast.dismiss(installId);
      runtime?.toaster.toast.info("Finish setting up", { id: askingId, description: next, duration: Infinity, action: { label: "Continue", onClick: open } });
    },
    hide: () => runtime?.toaster.toast.dismiss(askingId)
  }, nextDraw);
  let shouldRecord = false;
  let recording;
  let missedSessionStart;
  let hasHeardSessionStart = false;
  const heldListens = new Map;
  let settleStart = () => {
    return;
  };
  const startSettled = new Promise((resolve) => settleStart = resolve);
  let installSettled;
  let settleInstall = () => {
    return;
  };
  const whenInstalled = () => phase === "installing" || phase === "waiting" ? installSettled ??= new Promise((resolve) => {
    settleInstall = () => {
      installSettled = undefined;
      resolve();
    };
  }) : undefined;
  const claude = () => {
    if (runtime === undefined)
      throw new Error(`${definition.name}: the lifecycle has not started. registerMod(addHook, mod, options) starts it at session.start.`);
    return runtime.claude;
  };
  const installing = (description) => runtime?.toaster.toast.loading("Installing", { id: installId, ...description === undefined ? {} : { description } });
  const toastFailure = (shown) => runtime?.toaster.fail(shown);
  const fail = (reason, fix, retry, error) => {
    phase = "failed";
    settleInstall();
    failure ??= new Error(`${definition.name}: ${reason}${/[.!?]$/.test(reason) ? "" : "."}${fix === undefined ? "" : ` ${fix}`}`, { cause: error });
    const again = retry === undefined ? {} : { retry: () => (failure = undefined, stopRetrying(), retry().catch(report)) };
    toastFailure({ id: installId, message: reason, ...fix === undefined ? {} : { description: fix }, ...error === undefined ? {} : { error }, ...again, isCritical: true });
    watchRecord();
  };
  const notSetUp = () => {
    const why = failure === undefined ? "" : messageOf(failure);
    const own = `${definition.name}: `;
    return why === "" ? `${definition.name} is not set up.` : `${definition.name} is not set up: ${why.startsWith(own) ? why.slice(own.length) : why}`;
  };
  const installAgain = () => install();
  const updateAgain = () => claude().store.delete(cmodUpdatedKey).then(installAgain);
  let retrying;
  const retryLater = (next) => {
    const seconds = installRetrySeconds[Math.min(next.tries, installRetrySeconds.length - 1)];
    retrying?.timer.cancel();
    retrying = { ...next, tries: next.tries + 1, timer: claude().clock.after(seconds * 1000, () => void retryInBackground().catch(report)) };
    fail(next.reason, `Trying again in ${seconds} s.`, installAgain);
  };
  const stopRetrying = () => {
    retrying?.timer.cancel();
    retrying = undefined;
  };
  const failInstall = (reason, when) => {
    if (when === undefined) {
      stopRetrying();
      return fail(reason, undefined, installAgain);
    }
    retryLater({ when, tries: retrying?.when === when ? retrying.tries : 0, reason });
  };
  const retryInBackground = async () => {
    if (phase !== "failed" || retrying === undefined)
      return;
    if (await recover()) {
      stopRetrying();
      return whenActive();
    }
    await install(true);
    await whenActive();
  };
  const finish = async () => {
    await programs?.refresh();
    phase = "ready";
    activation ??= new Promise((resolve) => claude().clock.after(0, () => resolve(activate().catch(report))));
    settleInstall();
    claude().ui.invalidate("ui.render");
  };
  const recordThroughCmod = async () => {
    if (plugin === undefined || await newestCmodVersion(claude()) === undefined)
      return;
    let failed;
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ["cmod", "setup", plugin.root, "--events"], env: { CLAUDE_CODE_SESSION_ID: await claude().session.id() } }), (text) => {
      const event = parseEvent(text);
      if (event.type === "done")
        shouldRecord = false;
      if (event.type === "failed")
        failed = event.message;
    });
    if (!shouldRecord) {
      runtime?.toaster.toast.dismiss(recordId);
      return programs?.refresh();
    }
    if (failed !== undefined)
      return void toastFailure({ id: recordId, message: failed, retry: record, isCritical: true });
    throw new Error(`cmod setup ${formatExit(code, lastError)}`);
  };
  const isInstalledCopy = async () => {
    await recording;
    if (plugin === undefined || plugin.name === cmodPluginName)
      return true;
    const recorded = await readRecord((path) => claude().fs.read(path).catch(ifMissing(undefined)), plugin.store, plugin.name);
    return recorded === undefined || recorded.root === plugin.root;
  };
  const record = () => {
    recording ??= recordThroughCmod().catch((error) => claude().ui.warn("record", `${definition.name} has no cmod record yet: ${messageOf(error)}`)).finally(() => {
      recording = undefined;
    });
  };
  const saveOption = async (key, text) => {
    const option = definition.options?.[key];
    if (option === undefined || plugin === undefined)
      return `${definition.name} has no option ${key}.`;
    const value = option.type === "number" ? Number(text) : option.type === "toggle" ? text.trim() === "true" : option.type === "list" ? text.split(",").map((item) => item.trim()).filter((item) => item !== "") : text;
    const misfit = option.type === "toggle" && !["true", "false"].includes(text.trim()) ? "takes true or false" : fitsOption(option, value);
    if (misfit !== undefined)
      return `${option.title} ${misfit}.`;
    const saved = await claude().process.run(["cmod", "options", "set", plugin.name, key, Array.isArray(value) ? value.join(",") : String(value)]);
    return saved.exitCode === 0 ? undefined : cmodError(saved.stderr, "options") || `cmod options set ${formatExit(saved.exitCode, "")}.`;
  };
  const askOptions = async (missing) => {
    if (!asksPerson || plugin === undefined || (await claude().session.surfaces()).length === 0)
      return false;
    const declared = definition.options ?? {};
    const asked = missing.keys.flatMap((key) => {
      const option = declared[key];
      return option === undefined ? [] : [[key, option]];
    });
    if (!await installer.options(asked, saveOption))
      return false;
    const prefix = `${plugin.name}.`;
    const rows = await claude().config.list();
    pluginOptions = { ...pluginOptions, ...Object.fromEntries(rows.filter((row) => row.key.startsWith(prefix)).map((row) => [row.key.slice(prefix.length), row.value])) };
    return true;
  };
  const isStepDone = async (active, step) => {
    try {
      return await step.isDone(active);
    } catch (error) {
      toastFailure({ id: `step:${step.title}`, message: `The ${step.title} step's isDone failed`, error });
      return;
    }
  };
  const pendingSteps = async (active) => {
    const pending = [];
    for (const step of definition.installer ?? [])
      if (await isStepDone(active, step) !== true)
        pending.push(step.title);
    return pending;
  };
  const runSteps = async (active) => {
    const steps = asksPerson ? definition.installer ?? [] : [];
    try {
      for (const [index, step] of steps.entries()) {
        const isDone = await isStepDone(active, step);
        if (isDone === undefined)
          break;
        if (isDone)
          continue;
        const isAnswered = (await claude().session.surfaces()).length > 0 && await installer.step(active, step, index + 1, steps.length);
        if (!isAnswered) {
          runtime?.toaster.toast.warning(steps.length - index === 1 ? "Needs one more step" : `Needs ${steps.length - index} more steps`, {
            id: "cmod:steps",
            description: `Starting with ${step.title}.`,
            duration: Infinity,
            action: { label: "Finish", onClick: () => runSteps(active) }
          });
          break;
        }
      }
    } finally {
      await installer.close();
    }
  };
  const activate = async () => {
    if (runtime === undefined || plugin === undefined)
      return;
    const activeRouter = createRouter();
    startingRouter = activeRouter;
    const active = await createMod(definition, { ...runtime, router: activeRouter, dataFolder: dataFolder(plugin.store, plugin.name), store: plugin.store, permissionRoutes, options: pluginOptions, nextDraw, installer, serveCmodPlugin, isInstalledCopy }).catch(async (error) => {
      if (error instanceof MissingOptions && await askOptions(error))
        return;
      await installer.close();
      fail(messageOf(error), error instanceof MissingOptions ? `Retry asks for ${error.keys.length === 1 ? "it" : "them"}.` : undefined, begin, error);
      throw error;
    }).finally(() => {
      startingRouter = undefined;
    });
    if (active === undefined)
      return activate();
    const { added } = active;
    mod = active.mod;
    imports = active.imports;
    raise = active.raise;
    settingsLoaded = active.settingsLoaded;
    router = activeRouter;
    phase = "active";
    stopWatchingRecord();
    const held = [...heldListens.values()];
    heldListens.clear();
    for (const call of held) {
      const failed = (error) => void toastFailure({ id: `listens:${String(call.caller)}`, message: `${String(call.caller)} hears nothing from this session`, error });
      activeRouter.dispatch("cmod.call", call, async () => ({ deny: `${definition.name} has no method ${call.method}.` })).then((answer) => ("deny" in answer) ? failed(new Error(answer.deny)) : undefined, failed);
    }
    runtime.claude.ui.invalidate("ui.render");
    if (definition.name === cmodPluginName)
      runtime.claude.ui.invalidate("command.describe");
    runSteps(active.mod).catch((error) => toastFailure({ id: "cmod:steps", message: "Its installer stopped", error, isCritical: true }));
    const missed = missedSessionStart;
    missedSessionStart = undefined;
    if (missed !== undefined)
      await replaySessionStart(missed);
    if (await runtime.claude.store.get(announcedKey) !== undefined) {
      runtime.toaster.toast.dismiss(installId);
      return;
    }
    await runtime.claude.store.set(announcedKey, { version: plugin.version ?? "" });
    const { toaster } = runtime;
    announcementOf(runtime.claude, plugin, added, openSettings).then(({ message, ...options }) => toaster.toast.success(message, { id: installId, duration: announcementMs, ...options })).catch((error) => toastFailure({ id: installId, message: "Could not say what it installed", error }));
  };
  const replaySessionStart = async (e) => {
    hasHeardSessionStart = true;
    const answer = await router.dispatch("classic.SessionStart", e, async () => ({})).catch((error) => {
      toastFailure({ id: "classic.SessionStart", message: "The SessionStart hook failed", error });
      return {};
    });
    const { additionalContext, ...unread } = answer;
    for (const text of additionalContext ?? []) {
      const added = await claude().session.append({ message: { type: "user", content: [{ type: "text", text }] } });
      if (added.deny !== undefined)
        claude().ui.warn("session-start:note", `${definition.name}: Claude Code refused its SessionStart note: ${added.deny}`);
    }
    if (Object.keys(unread).length > 0) {
      claude().ui.warn("session-start:late", `${definition.name} started after Claude Code's SessionStart, so Claude Code did not read ${Object.keys(unread).join(", ")} from its SessionStart hooks.`);
    }
  };
  const install = async (isQuiet = false) => {
    if (plugin === undefined)
      return;
    phase = "installing";
    if (plugin.name === cmodPluginName) {
      download(plugin.root);
      return finish();
    }
    const found = await newestCmodVersion(claude());
    if (!fits(found))
      return waitForcmod(found);
    if (!isQuiet)
      installing();
    let outcome;
    let retries;
    const { code, lastError } = await readLines(claude().process.spawn({ argv: ["cmod", "setup", plugin.root, "--events"], env: { CLAUDE_CODE_SESSION_ID: await claude().session.id() } }), (text) => {
      const event = parseEvent(text);
      if (event.type === "progress" && !isQuiet)
        installing(progressOf(event));
      if (event.type === "retries")
        retries = event.when;
      if (event.type === "done" || event.type === "failed")
        outcome = event;
    });
    if (outcome?.type === "done") {
      stopRetrying();
      return finish();
    }
    return failInstall(outcome?.type === "failed" ? outcome.message : `cmod setup ${formatExit(code, lastError)}`, retries);
  };
  const fits = (found) => found !== undefined && isAtLeast(found, oldestCmodVersion);
  const waitForcmod = (found) => {
    phase = "waiting";
    installing("Waiting for cmod");
    let latest = found;
    let check;
    const stop = () => {
      timer.cancel();
      longWait.cancel();
    };
    const poll = (ms) => claude().clock.every(ms, () => {
      check ??= newestCmodVersion(claude()).then((version) => {
        check = undefined;
        latest = version;
        if (!fits(version))
          return;
        stop();
        return install();
      }).catch((error) => {
        stop();
        report(error);
      });
    });
    let timer = poll(cmodCheckMs);
    const longWait = claude().clock.after(cmodWaitMs, () => {
      timer.cancel();
      timer = poll(cmodSlowCheckMs);
      if (latest === undefined)
        return installing("Still waiting for cmod to download cmod. See cmod's own line.");
      const found = latest;
      const tried = `${found} to ${oldestCmodVersion}`;
      return claude().store.get(cmodUpdatedKey).then(async (updated) => {
        if (updated === tried) {
          stop();
          return fail(`${definition.name} needs cmod ${oldestCmodVersion} or later, and the newest cmod is ${found}.`, undefined, updateAgain);
        }
        await claude().store.set(cmodUpdatedKey, tried);
        installing(`${definition.name} needs cmod ${oldestCmodVersion} or later, and this computer has cmod ${found}, so cmod is updating itself.`);
        const { code, lastError } = await readLines(claude().process.spawn({ argv: ["cmod", "update", "cmod"] }), () => {
          return;
        });
        if (code === 0)
          return;
        stop();
        fail(`${definition.name} needs cmod ${oldestCmodVersion} or later, and updating cmod ${found} ${formatExit(code, lastError)}`, undefined, updateAgain);
      }).catch(report);
    });
  };
  const download = (root) => {
    const downloading = (description) => runtime?.toaster.toast.loading("Downloading the cmod program", { id: downloadId, ...description === undefined ? {} : { description } });
    downloading();
    const downloaded = readLines(claude().process.spawn({ argv: ["sh", "-c", "./setup/bootstrap.sh"], cwd: root }), (text) => {
      const event = parseEvent(text);
      if (event.type === "progress")
        downloading(progressOf(event));
    }).then(({ code, lastError }) => {
      if (code !== 0)
        throw new Error(`bootstrap ${formatExit(code, lastError)}`);
    });
    programs?.waitFor(downloaded);
    downloaded.then(() => runtime?.toaster.toast.dismiss(downloadId), (error) => toastFailure({ id: downloadId, message: messageOf(error), retry: async () => download(root), isCritical: true }));
  };
  const begin = async () => {
    if (readStarted === undefined)
      return;
    const started = await readStarted(claude());
    plugin = started;
    recordMs = await stampOf(recordPath(started.store, started.name));
    if (started.isInstalled) {
      shouldRecord = started.shouldRecord;
      if (shouldRecord)
        record();
      activation = undefined;
      return activate();
    }
    if (started.version === undefined)
      return fail("no version to install", 'Its author adds "version" to .claude-plugin/plugin.json.');
    install().catch(report);
  };
  const report = (error) => {
    failure = error;
    if (phase !== "failed")
      fail(messageOf(error), undefined, begin, error);
  };
  const stampOf = async (path) => {
    const stat = await claude().fs.stat(path).catch(ifMissing(undefined));
    return stat?.kind === "file" ? stat.mtimeMs : 0;
  };
  let recordMs = 0;
  let readStarted;
  const isNewlyInstalled = async () => {
    if (plugin === undefined || readStarted === undefined)
      return false;
    const modifiedMs = await stampOf(recordPath(plugin.store, plugin.name));
    if (modifiedMs === recordMs)
      return false;
    recordMs = modifiedMs;
    const current = await readStarted(claude());
    if (!current.isInstalled)
      return false;
    plugin = current;
    return true;
  };
  const recover = async () => {
    if (phase !== "failed" || !await isNewlyInstalled())
      return false;
    failure = undefined;
    activation = undefined;
    await finish();
    return true;
  };
  let recordCheck;
  let checking;
  let startingSession;
  const watchRecord = () => {
    recordCheck ??= claude().clock.every(recordCheckMs, () => {
      checking ??= recover().then(() => {
        return;
      }).catch((error) => claude().ui.warn("record:watch", `${definition.name} could not read whether another cmod installed it: ${messageOf(error)}`)).finally(() => {
        checking = undefined;
      });
    });
  };
  const stopWatchingRecord = () => {
    recordCheck?.cancel();
    recordCheck = undefined;
  };
  const whenActive = async () => {
    if (phase === "ready")
      activation ??= activate().catch(report);
    if (activation !== undefined && phase !== "active")
      await activation;
  };
  const held = (work, signal) => runtime === undefined ? work.then(() => false) : new Promise((resolve) => {
    const limit = claude().clock.after(startHoldMs, () => resolve(true));
    if (signal?.aborted === true)
      resolve(false);
    signal?.addEventListener("abort", () => resolve(false), { once: true });
    work.then(() => {
      limit.cancel();
      resolve(false);
    });
  });
  const holdUntilStarted = (signal) => held(startSettled.then(whenActive), signal);
  const holdUntilInstalled = (signal) => held(startSettled.then(whenInstalled).then(whenActive), signal);
  const holdUntilActive = (signal) => {
    const activating = whenActive();
    return activation !== undefined && phase !== "active" ? held(activating, signal) : activating.then(() => false);
  };
  const routed = async (event, e, next, signal) => {
    if (imports !== undefined)
      bind(imports);
    const asked = e;
    if (event === "cmod.call" && asked.to === definition.name && asked.caller === cmodPluginName) {
      if (asked.method === partMethods.shown)
        installer.hear(asked.input);
      const answered = installer.answer(asked.method, asked.input);
      if (answered !== undefined)
        return await answered.catch((error) => ({ deny: `${definition.name}: ${messageOf(error)}` }));
      if (asked.method === partMethods.shown && phase !== "active")
        return { value: null };
    }
    if (event === "classic.SessionStart") {
      missedSessionStart = undefined;
      hasHeardSessionStart = true;
    }
    if (event === "classic.SessionStart" && runtime === undefined) {
      missedSessionStart = e;
      return next(e);
    }
    if (shouldRecord && event === "classic.UserPromptSubmit")
      record();
    if (event === "classic.UserPromptSubmit" || event === "classic.SessionStart")
      await recover().catch((error) => claude().ui.warn("recover", `${definition.name} stays stopped: ${messageOf(error)}`));
    const tool = e.tool;
    const isCallToThisMod = event === "cmod.call" && e.to === definition.name || event === "tool.call" && typeof tool === "string" && tool.startsWith(`mcp__${definition.name}__`);
    if (event === "cmod.call" && !isCallToThisMod)
      return next(e);
    const isListen = isCallToThisMod && event === "cmod.call" && listenMethods.includes(asked.method);
    if (isListen && phase !== "active") {
      heldListens.set(`${asked.caller}
${asked.method}
${String(asked.input.session)}`, asked);
      startSettled.then(whenInstalled).then(whenActive);
      return { value: null };
    }
    const waitsForInstall = isCallToThisMod && !(event === "cmod.call" && answeredAtOnce.includes(asked.method));
    const isLate = await (waitsForInstall ? holdUntilInstalled(signal) : event === "classic.SessionStart" || event === "session.append" || isCallToThisMod ? holdUntilStarted(signal) : holdUntilActive(signal));
    if (event === "classic.SessionStart" && phase !== "active") {
      missedSessionStart = e;
      return next(e);
    }
    if (isCallToThisMod && phase !== "active")
      return { deny: phase === "failed" ? notSetUp() : stillInstalling(definition.name) };
    if (isLate && phase !== "active")
      return (startingRouter ?? router).dispatchFailure(event, e, new Error(`it was still starting after ${startHoldMs / 1000} s`), next, false);
    const call = e;
    if (event === "cmod.call" && call.to === definition.name && mod !== undefined) {
      if (call.method === pendingStepsMethod)
        return { value: await pendingSteps(mod) };
      if (call.method === finishStepsMethod) {
        const active = mod;
        const opened = await installer.collect(() => Promise.race([runSteps(active).catch((error) => void toastFailure({ id: "cmod:steps", message: "Could not finish the setup", error, isCritical: true })), installer.shown()]));
        return { value: opened };
      }
    }
    if (event === "classic.UserPromptSubmit" && phase === "active" && !hasHeardSessionStart) {
      const { session_id, transcript_path, cwd } = e;
      await replaySessionStart({ session_id, transcript_path, cwd, hook_event_name: "SessionStart", source: "resume" });
    }
    const answer = router.dispatch(event, e, next, signal);
    const render = e;
    if (event !== "ui.render" || render.component !== "AbovePrompt" || runtime === undefined)
      return answer;
    return runtime.toaster.draw(await answer, runtime.claude.ui.resolve(render), render.props, render.requestId);
  };
  return {
    get phase() {
      return phase;
    },
    get mod() {
      return mod;
    },
    get failure() {
      return failure;
    },
    get toasts() {
      return runtime?.toaster.shown ?? [];
    },
    async raise(method, payload) {
      if (raise === undefined || imports === undefined)
        throw new Error(`${definition.name} has not started, so ${method} has no listener yet.`);
      bind(imports);
      return raise(method, payload, unaborted);
    },
    async settingsLoaded() {
      await settingsLoaded?.();
    },
    async start(claudeCalls, read) {
      if (runtime !== undefined)
        return;
      const open = (href, press) => void openLink(claudeCalls, href, press.surface).then((done) => done === "copied" && runtime?.toaster.toast.success("Copied the link", { description: "Paste it in your browser." }), (error) => toastFailure({ id: "open-link", message: "Could not open the link", error, isCritical: true }));
      let hasNerdFont = false;
      const naming = {
        ...claudeCalls,
        ui: {
          ...claudeCalls.ui,
          warn: (id, text) => runtime === undefined ? claudeCalls.ui.warn(id, text) : runtime.toaster.warn(id, text),
          resolve: (e) => forClaudeCode(claudeCalls.ui.resolve(e), e.surface, open, { hasNerdFont })
        },
        session: { ...claudeCalls.session, id: async () => startingSession ?? claudeCalls.session.id() }
      };
      programs = locatingPrograms(naming);
      const callingCmod = {
        ...naming,
        cmod: {
          async call(input) {
            if (input.to === definition.name)
              await holdUntilStarted();
            return answeringOwnCalls(claudeCalls, router).cmod.call(input);
          }
        }
      };
      runtime = { claude: programs.claude, toaster: createToaster(callingCmod, definition.name, () => plugin?.version) };
      readStarted = read;
      try {
        drawCount = await claudeCalls.clock.now() * drawsPerMs;
        hasNerdFont = await roundsBarEnds(claudeCalls).catch((error) => (claudeCalls.ui.warn("preferences:read", `${definition.name} rounds its bars only in a terminal it knows: ${messageOf(error)}`), false)) || isNerdFontTerminal(await claudeCalls.env.terminal());
        await programs.refresh();
        await begin().catch(report);
      } finally {
        settleStart();
      }
    },
    async route(event, e, next, signal) {
      if (event !== "classic.SessionStart")
        return settledAfterAbort(routed(event, e, next, signal), signal);
      const started = e.session_id;
      startingSession = started;
      try {
        return await settledAfterAbort(routed(event, e, next, signal), signal);
      } finally {
        if (startingSession === started)
          startingSession = undefined;
      }
    },
    async caught(event, e, next, { error: { kind, message }, called }) {
      const call = e;
      const isAsk = event === "cmod.call" && call.to === definition.name && beforeAskOf(call) !== undefined;
      const reasons = { timeout: overranHook, throw: message ?? "it threw" };
      const reason = reasons[kind];
      if (reason === undefined)
        return isAsk ? { value: null } : next(e);
      const error = new Error(reason);
      const failedBeneath = called && kind === "throw" ? await next(e).then(() => {
        return;
      }, messageOf) : undefined;
      if (failedBeneath === undefined || failedBeneath !== message)
        toastFailure({ id: `stopped:${event}`, message: `Claude Code stopped its ${event.replace(/^classic\./, "")} hook`, error });
      return (startingRouter ?? router).dispatchFailure(event, e, error, next, called);
    }
  };
}
async function createMod(definition, runtime) {
  const { router, toaster } = runtime;
  const report = (failure) => void toaster.fail(failure);
  const claude = answeringOwnCalls(withBareRefusals(runtime.claude), router);
  const added = [];
  const announce = (feature) => {
    added.push(feature);
  };
  const [session, root, startCwd, home, configHome, cacheHome] = await Promise.all([claude.session.id(), claude.session.root(), claude.session.cwd(), claude.env.home(), claude.env.configHome(), claude.env.cacheHome()]);
  const configRoot = configHome ?? (home === undefined ? undefined : `${home}/.claude`);
  const places = { home, configRoot, projectRoot: () => modState.root };
  const files = createModFiles({ name: definition.name, claude, places, report });
  let cwd = startCwd;
  let loadedCwd = startCwd;
  let staleCwd;
  let forkedFrom;
  let parentAsked;
  let hasEarlierPrompts = true;
  let agentType;
  let parts;
  const borrowed = (styler, cached, input, scope) => {
    const name = `The markdown style of ${styler}`;
    parts?.fill(styler, cached, input, name)?.then(() => claude.ui.invalidate("ui.render"));
    return parts?.element(styler, cached, `${styler}/markdown:${scope}:`, name, `markdown:${styler}`);
  };
  const provided = createProviders({
    name: definition.name,
    call: (to, method, input) => claude.cmod.call({ to, method, input }),
    changed: () => area.relisted(),
    after: (ms, run) => claude.clock.after(ms, run),
    report: (error) => report({ id: "interfaces", message: "A provider listener failed", error })
  });
  const area = createUi({ name: definition.name, claude, router, report, announce, mod: () => mod, borrowed, nextDraw: runtime.nextDraw, provided: () => provided.provided() });
  const askParent = async () => {
    if (definition.name === cmodPluginName)
      return;
    try {
      const parent = await claude.cmod.call({ to: cmodPluginName, method: "forkParent", input: null });
      return typeof parent === "string" ? parent : undefined;
    } catch (error) {
      claude.ui.warn("fork:values", `${definition.name} starts without the session values of the conversation it was forked from: ${messageOf(error)}`);
      return;
    }
  };
  const forkParent = () => parentAsked ??= askParent().then((parent) => {
    forkedFrom = parent;
    return parent;
  });
  const stateChanged = () => {
    area.changed();
    runtime.installer.changed();
  };
  const modState = createState({ name: definition.name, initial: definition.state ?? {}, session, root, claude, report, changed: stateChanged, forkParent });
  const modOptions = createOptions({ name: definition.name, declared: definition.options ?? {}, fromClaude: runtime.options, claude, report, changed: modState.changed });
  const hookOn = (hook, listener, failed) => router.add(`classic.${hook}`, classicHook(hook, listener, report), failed === undefined ? undefined : classicFailure(failed));
  const expand = (path) => homePrefix.test(path) ? resolvedPath(path, places) : path;
  const settingsFile = (source) => ({
    read: () => claude.settings.read({ source }),
    async update(values) {
      await claude.cmod.call({ to: cmodPluginName, method: "updateSettings", input: { mod: definition.name, source, project: modState.root, values } });
    }
  });
  const client = createSessionsClient({
    name: definition.name,
    claude,
    report: (id, message, error) => report({ id, message, error }),
    hookOn: (hook, listener, failed) => hookOn(hook, listener, failed),
    routeOn: (event, hook, failed) => router.add(event, hook, failed),
    permissionRoutes: runtime.permissionRoutes
  });
  let followed;
  const watches = createWatches(claude, report);
  const followFolders = (project, folder) => {
    if (followed === undefined)
      return;
    followed = { ...followed, project, cwd: folder };
    client.follow(followed);
  };
  let device;
  const settingsChangeOf = ({ source, file_path }) => ({ source: source.replace("_settings", ""), ...file_path === undefined ? {} : { path: file_path } });
  const matchedListener = (matcherOrListener, maybeListener) => (change) => (maybeListener === undefined || matches(change, matcherOrListener)) && (maybeListener ?? matcherOrListener)(change);
  const settingsListeners = new Set;
  const loadingSettings = [];
  const settingsLoaded = async () => {
    bind(imports);
    await Promise.all(loadingSettings.splice(0).flatMap((change) => [...settingsListeners].map(async (listener) => {
      try {
        await listener(change);
      } catch (error) {
        report({ id: "settings:onChange", message: "The settings.onChange listener failed", error });
      }
    })));
  };
  router.add("classic.ConfigChange", async (e, next) => {
    const below = await next(e);
    if (below.block === undefined && settingsListeners.size > 0) {
      loadingSettings.push(settingsChangeOf(e));
      claude.clock.after(settingsLoadMs, () => void settingsLoaded());
    }
    return below;
  });
  const imports = {
    sessions: client.sessions,
    commands: {
      list: async () => (await claude.command.list()).map(({ name, description, source, plugin }) => ({ name, description, source, ...plugin === undefined ? {} : { plugin } })),
      run: async (command, args) => {
        const { text, context } = await claude.command.run({ command, ...args === undefined ? {} : { args } });
        return { ...text === undefined ? {} : { text }, ...context === undefined || context.length === 0 ? {} : { note: context.join(`
`) } };
      },
      beforeRun: (...args) => client.listen("beforeRun", args),
      onRun: (...args) => client.listen("onRun", args)
    },
    config: {
      list: async () => (await claude.config.list()).map(({ key, label, description, kind, value, options, provider, isLocked }) => ({
        key,
        label,
        kind,
        value,
        isLocked,
        ...description === undefined ? {} : { description },
        ...options === undefined ? {} : { options },
        ...provider.plugin === "engine" ? {} : { plugin: provider.plugin }
      }))
    },
    settings: {
      user: settingsFile("user"),
      project: settingsFile("project"),
      local: settingsFile("local"),
      beforeChange: (matcherOrListener, maybeListener) => {
        const listener = matchedListener(matcherOrListener, maybeListener);
        return hookOn("ConfigChange", async (input) => {
          const refuse = (await listener(settingsChangeOf(input)))?.refuse;
          return typeof refuse === "string" ? { block: refuse } : undefined;
        });
      },
      onChange: (matcherOrListener, maybeListener) => {
        const listener = matchedListener(matcherOrListener, maybeListener);
        settingsListeners.add(listener);
        return { remove: () => void settingsListeners.delete(listener) };
      }
    },
    model: { complete: (completion, options) => claude.model.complete(completion, options) },
    fs: {
      read: (path) => claude.fs.read(expand(path)),
      write: (path, text) => claude.fs.write(expand(path), text),
      exists: (path) => claude.fs.exists(expand(path)),
      find: (glob) => files.find(glob),
      list: async (path) => (await claude.fs.list(path === undefined ? undefined : expand(path))).map(({ name, kind, size, mtimeMs, isLink }) => ({ name, isFile: kind === "file", isFolder: kind === "dir", isLink, size, modifiedAt: mtimeMs })),
      async stat(path, options) {
        const { kind, size, mtimeMs, isLink, realPath } = await claude.fs.stat(expand(path), options);
        return { isFile: kind === "file", isFolder: kind === "dir", isLink, size, modifiedAt: mtimeMs, ...realPath === undefined ? {} : { realPath } };
      },
      onChange: ({ path }, listener) => watches.add([path].flat().map((each) => resolvedPath(each, places)), (change) => {
        bind(imports);
        return listener(change);
      })
    },
    metadata: {
      read: (path) => files.read(path),
      update: (path, change) => files.update(path, change)
    },
    process: {
      run: (argv, init) => claude.process.run(argv, init),
      spawn: (argv, init) => claude.process.spawn({ ...init, argv })
    },
    http: { fetch: (url, init) => claude.http.fetch(url, init) },
    device: {
      read: () => device ??= claude.device.read().catch((error) => {
        device = undefined;
        throw error;
      })
    },
    clipboard: {
      async write(text) {
        await toaster.copy(text);
      }
    },
    mods: {
      isLoaded: async (name) => await claude.cmod.call({ to: cmodPluginName, method: loadedMethod, input: { name } }) === true
    },
    provide: (name, methods) => provided.provide(name, methods),
    providers: (name) => provided.providers(name)
  };
  const timer = (ms, subject, repeats, listener) => {
    let isFiring = false;
    let isRunning = true;
    let firedAt = 0;
    let isStallTold = false;
    const tellStall = async () => {
      const ranMs = await claude.clock.now() - firedAt;
      if (isStallTold || ranMs < Math.max(checked * stallTicks, stallMs))
        return;
      isStallTold = true;
      claude.ui.warn(`${subject}:${ms}:stalled`, `${definition.name}: one run of its ${subject} ${ms} ms timer has gone on for ${Math.round(ranMs / 1000)} s, so the timer skipped every tick since. Give what the listener awaits a deadline.`);
    };
    const fire = () => {
      if (!repeats)
        isRunning = false;
      if (isFiring) {
        tellStall();
        return;
      }
      isFiring = true;
      isStallTold = false;
      Promise.resolve().then(async () => {
        firedAt = await claude.clock.now();
        bind(imports);
        return listener();
      }).catch((error) => report({ id: `${subject}:${ms}`, message: `The ${subject} ${ms} ms timer failed`, error })).finally(() => {
        isFiring = false;
      });
    };
    const checked = checkedMs(definition.name, `mod.${subject}`, ms);
    const started = repeats ? claude.clock.every(checked, fire) : claude.clock.after(checked, fire);
    return {
      get isRunning() {
        return isRunning;
      },
      stop() {
        isRunning = false;
        started.cancel();
      }
    };
  };
  const hotkeys = await createHotkeys({ name: definition.name, declared: definition.hotkeys ?? {}, configRoot, claude, router, answerInput: area.answerInput, report });
  const secret = async (action, key, value) => {
    const { exitCode, stdout, stderr } = await claude.process.run(["cmod", "secrets", action, definition.name, key], value === undefined ? undefined : { stdin: value });
    if (exitCode !== 0)
      throw new Error(`${definition.name}: mod.secrets.${action}: ${cmodError(stderr, "secrets") || `cmod secrets ${formatExit(exitCode, "")}.`}`);
    return stdout;
  };
  const mod = {
    name: definition.name,
    folder: claude.plugin.root,
    dataFolder: runtime.dataFolder,
    cacheFolder: cacheFolder({ HOME: home, XDG_CACHE_HOME: cacheHome }, claude.plugin.name),
    secrets: {
      get: async (key) => await secret("get", key) || undefined,
      store: async (key, value) => void await secret("store", key, value),
      delete: async (key) => void await secret("delete", key)
    },
    state: modState.state,
    get options() {
      return modOptions.values;
    },
    hotkeys,
    every: (ms, listener) => timer(ms, "every", true, listener),
    after: (ms, listener) => timer(ms, "after", false, listener),
    use: (job) => job({ mod, announce, reserveName }),
    log: (text, options) => {
      if (options?.level === "error")
        report({ id: `log:${text}`, message: text });
      else if (options?.level === "warning")
        claude.ui.warn(`log:${text}`, `${definition.name}: ${text}`);
      else
        claude.ui.log(`${definition.name}: ${text}`, { to: options?.to ?? "debug" });
    },
    panes: area.panes,
    views: area.views,
    pages: area.pages,
    settings: area.settings,
    widgets: area.widgets,
    styles: area.styles,
    toast: toaster.toast,
    ask: (question, options) => claude.ui.ask(question, options),
    dependencies: dependencyCalls(claude, (call, task) => beforeDeadline(claude.clock, callDeadline, call, () => task))
  };
  bind(imports);
  const followSession = async (isAfterCd = false) => {
    try {
      const [nextRoot, reportedCwd] = await Promise.all([claude.session.root(), claude.session.cwd()]);
      const oldCwd = cwd;
      const hasMovedRoot = nextRoot !== modState.root;
      if (isAfterCd && hasMovedRoot && relativePath(nextRoot, reportedCwd) === undefined)
        staleCwd = reportedCwd;
      if (reportedCwd !== staleCwd)
        staleCwd = undefined;
      const nextCwd = staleCwd === undefined ? reportedCwd : nextRoot;
      if (!hasMovedRoot && nextCwd === oldCwd)
        return;
      cwd = nextCwd;
      followFolders(nextRoot, nextCwd);
      await modState.moveTo(nextRoot).catch((error) => {
        if (cwd === nextCwd)
          cwd = loadedCwd;
        followFolders(modState.root, cwd);
        throw error;
      });
      if (hasMovedRoot)
        await modOptions.load(nextRoot);
      loadedCwd = nextCwd;
      if (!hasMovedRoot)
        area.changed();
      if (nextCwd === oldCwd)
        return;
      const moved = { session_id: await claude.session.id(), cwd: nextCwd, hook_event_name: "CwdChanged", old_cwd: oldCwd, new_cwd: nextCwd };
      await router.dispatch("classic.CwdChanged", moved, async () => ({}));
    } catch (error) {
      report({ id: "cmod:follow", message: `Keeps the state of ${modState.root} until the next prompt or folder move`, error });
    }
  };
  const followCurrent = async (id, title) => {
    const [model, usage, { transcriptPath }] = await Promise.all([claude.session.model(), claude.session.usage(), claude.session.info()]);
    followed = { id, title: title ?? "", project: modState.root, cwd, ...transcriptPath === "" ? {} : { transcriptPath }, model, startedAt: new Date(usage.startedAt).toISOString(), ...forkedFrom === undefined ? {} : { forkedFrom }, ...agentType === undefined ? {} : { agentType } };
    client.follow(followed);
  };
  router.add("classic.SessionStart", async (e, next) => {
    agentType = e.agent_id === undefined ? e.agent_type : agentType;
    const previous = followed?.id;
    if (e.source === "fork" && previous !== undefined && previous !== e.session_id)
      forkedFrom = previous;
    else if (e.session_id !== previous) {
      forkedFrom = undefined;
      parentAsked = undefined;
    }
    hasEarlierPrompts = e.source !== "startup" && e.source !== "clear";
    await followCurrent(e.session_id, e.session_title).catch((error) => report({ id: "cmod:current", message: "Kept the details of the session from before", error }));
    await modState.switchSession(e.session_id, e.source, e.transcript_path).catch((error) => {
      report({ id: "cmod:session", message: `Kept its session values from before the ${e.source}`, error });
    });
    return next(e);
  });
  router.add("classic.UserPromptSubmit", async (e, next) => {
    staleCwd = undefined;
    await followSession();
    const isPerson = e.source === undefined || e.source === "user" || e.source === "sdk";
    await followCurrent(e.session_id, e.session_title || (isPerson && !hasEarlierPrompts && client.sessions.current.title === "" ? firstLine(e.prompt) : undefined)).catch((error) => report({ id: "cmod:current", message: "Kept the details of the session from before", error }));
    return next(e);
  });
  for (const event of ["classic.PostToolUse", "classic.PostToolUseFailure"]) {
    router.add(event, async (e, next) => {
      if (shellTools.includes(e.tool_name))
        await followSession();
      return next(e);
    });
  }
  router.add("command.run", async (e, next) => {
    const answer = await next(e);
    if (e.command === "cd") {
      await followSession(true);
      conversations?.moved();
    }
    return answer;
  });
  router.add("skill.prompt", userSkillHook(claude));
  router.add("ui.press", (e, next) => area.asked(() => next(e)));
  let api = {};
  let servedParts;
  const reportPart = (id, message, error) => report({ id, message, error });
  const tellRefusedPress = (to, error) => {
    if (messageOf(error).includes(stalePress))
      toaster.toast.warning(`The ${to} button was from an older drawing, so nothing ran`, { id: `press:${to}`, description: "Press the button it shows now." });
    else
      report({ id: `press:${to}`, message: `${to} did not take the press`, error, isCritical: true });
  };
  const pressElsewhere = (to, input) => void claude.cmod.call({ to, method: partMethods.press, input }).catch((error) => {
    parts?.forget(to);
    claude.ui.invalidate("ui.render");
    tellRefusedPress(to, error);
  });
  parts = drawnParts({ claude, report: reportPart, press: (to, input) => servedParts === undefined ? pressElsewhere(to, input) : servedParts.press(to, input) });
  const served = runtime.serveCmodPlugin?.({ claude, router, store: runtime.store, project: () => modState.root, report: reportPart, clear: (id) => toaster.toast.dismiss(id), tellRefusedPress, parts, markdownIn: area.markdownIn, tellStylers: area.restyled });
  const conversations = served?.conversations;
  const widgets = served?.widgets;
  servedParts = served?.parts;
  const tellColor = (to, told) => {
    if (told.session === "" || to === cmodPluginName)
      return;
    claude.clock.after(0, () => void claude.cmod.call({ to, method: conversationMethods.sessionColor, input: told }).catch((error) => {
      if (!isStillInstalling(to, error))
        claude.ui.warn("color:tell", `cmod: ${to} did not hear the session's color: ${messageOf(error)}`);
    }));
  };
  conversations?.onColor((told) => {
    client.recolor(told);
    for (const { mod: to } of servedParts?.declared() ?? [])
      tellColor(to, told);
  });
  router.add("cmod.call", async (e, next) => {
    if (e.to !== definition.name)
      return next(e);
    const call = e;
    if (e.method === conversationMethods.changed && call.caller === cmodPluginName) {
      const { session: changedSession, change } = e.input;
      client.changed(changedSession, change, next.signal);
      return { value: null };
    }
    if (e.method === conversationMethods.sessionColor && call.caller === cmodPluginName) {
      client.recolor(e.input);
      return { value: null };
    }
    const forProvider = call.caller === undefined ? undefined : provided.answer(e.method, e.input ?? {}, call.caller, next.signal);
    if (forProvider !== undefined)
      return { value: await forProvider };
    const ask = beforeAskOf(call);
    if (ask !== undefined)
      return { value: await client.answerBefore(ask.session, ask.event, ask.change, next.signal) ?? null };
    if (e.method === partMethods.changed && call.caller !== undefined && servedParts !== undefined) {
      const update = e.input;
      if (update.parts !== undefined && conversations !== undefined)
        tellColor(call.caller, conversations.color());
      return { value: { isHeld: servedParts.update(call.caller, update), stylers: servedParts.stylers() } };
    }
    if (call.caller !== undefined) {
      const turn = e.method === partMethods.draw ? e.input.turn : undefined;
      const answered = area.answer(e.method, turn === undefined ? e.input : { ...e.input, turn: client.turn(turn) }, call.caller);
      if (answered !== undefined)
        return answered.catch((error) => ({ deny: `${definition.name}: ${messageOf(error)}` }));
    }
    const served = await conversations?.answer(call);
    return served ?? answerCall(definition.name, api, e);
  }, (e, error) => {
    if (e.to !== definition.name)
      return;
    const ask = beforeAskOf(e);
    return ask === undefined ? { deny: `${definition.name}: ${error.message}` } : { value: client.failedBefore(ask.session, ask.event, ask.change, error) ?? null };
  });
  const agents = toolCalls(claude, router);
  keepEngine(mod, {
    claude,
    router,
    toolCalls: agents,
    report,
    hasPermissionCheck: () => runtime.permissionRoutes() !== undefined,
    answerInput: area.answerInput,
    spawnCmod: (args, env) => spawnCmod(claude, args, session, env),
    isInstalledCopy: runtime.isInstalledCopy,
    watches,
    interfaces: provided,
    ...widgets === undefined ? {} : { widgets },
    onServeUnreached: (listener) => conversations?.onUnreached(listener),
    ...servedParts === undefined ? {} : { parts: servedParts }
  });
  const names = new Set;
  const reserveName = (type, name, taken) => {
    const key = `${type}:${name}`;
    if (names.has(key))
      throw new Error(taken);
    names.add(key);
    return { remove: () => void names.delete(key) };
  };
  const removeUndeclaredServices = async () => {
    if (!await runtime.isInstalledCopy())
      return;
    for (const { name } of await claude.fs.list(serviceFolder(runtime.store, definition.name)).catch(ifMissing([]))) {
      const program = name.endsWith(".json") ? name.slice(0, -".json".length) : undefined;
      if (program !== undefined && !names.has(`service:${program}`))
        await runCmod(claude, ["program", definition.name, "--remove-service", "--", program], session);
    }
  };
  await failsAs("its state did not load", () => modState.load());
  await failsAs("its options did not load", () => modOptions.load(root));
  const missing = modOptions.missing;
  if (missing.length > 0)
    throw new MissingOptions(missing, missing.map((key) => definition.options?.[key]?.title ?? key));
  await failsAs("the details of its session did not load", () => followCurrent(session, undefined));
  const returned = await failsAs("its setup function threw", () => definition.setup(mod));
  api = apiOf(definition.name, returned);
  await failsAs("its open panes did not load", () => area.restorePanes());
  area.started();
  removeUndeclaredServices().catch((error) => report({ id: "program:services", message: "Could not stop a service it no longer runs", error }));
  return { mod, added, imports, raise: client.raise, settingsLoaded, area };
}
function apiOf(name, returned) {
  if (returned === undefined || returned === null)
    return {};
  if (typeof returned !== "object" || !Object.values(returned).every((method) => typeof method === "function"))
    throw new Error(`${name}: setup returns its API, an object of methods other mods call, or nothing. It returned ${typeof returned === "object" ? "an object with values that are not methods" : typeof returned}.`);
  return returned;
}
var longestTimerMs = 2147483647;
function checkedMs(name, subject, ms) {
  if (!Number.isInteger(ms) || ms <= 0 || ms > longestTimerMs)
    throw new Error(`${name}: ${subject} is ${ms}. Give a whole number of milliseconds above 0 and at most ${longestTimerMs}.`);
  return ms;
}
function beforeAskOf(call) {
  return call.method === conversationMethods.before && call.caller === cmodPluginName ? call.input : undefined;
}
async function failsAs(subject, step) {
  try {
    return await step();
  } catch (error) {
    throw new Error(`${subject}: ${messageOf(error)}`, { cause: error });
  }
}
function progressOf({ done, total, label }) {
  return Box({ gap: 2, children: [Progress({ value: total > 0 ? done / total * 100 : 0 }), Text({ dimColor: true, wrap: "truncate-end", children: label })] });
}

// node_modules/@cmodjs/core/register.js
var lifecycle;
var permissionCheck;
var registered;
var lockedRetryMs = [100, 300, 600];
var heldLock = "Lock file is already being held";
var timers2 = globalThis;
async function whenUnlocked(write) {
  for (const waitMs of lockedRetryMs) {
    try {
      return await write();
    } catch (error) {
      if (!messageOf(error).includes(heldLock))
        throw error;
      await new Promise((resolve) => void timers2.setTimeout(resolve, waitMs));
    }
  }
  return write();
}
async function startMod($, eventInput, passOn) {
  const claude = {
    plugin: { name: $.plugin.name, root: $.plugin.root },
    ui: {
      log: (text, options) => $.ui.log(text, options),
      warn: (_id, text) => $.ui.log(text, { to: "debug" }),
      notice: (toolUseId, text) => $.ui.notice(toolUseId, text),
      toast: (text, options) => $.ui.toast(text, options),
      invalidate: (event) => $.ui.invalidate(event),
      ask: (question, options) => $.ui.ask(question, options),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
      panes: () => $.ui.panes(),
      scroll: (args) => $.ui.scroll(args),
      copy: (args) => $.ui.copy(args),
      focus: (args) => $.ui.focus(args),
      resolve: (render) => $.ui.resolve(render)
    },
    process: {
      run: (argv, init) => $.process.run(argv, init),
      spawn: (request) => $.process.spawn(request)
    },
    fs: {
      read: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: (path) => $.fs.list(path),
      exists: (path) => $.fs.exists(path),
      stat: (path, options) => $.fs.stat(path, options)
    },
    http: { fetch: (url, init) => $.http.fetch(url, init) },
    settings: { read: (args) => $.settings.read(args) },
    config: { list: () => $.config.list() },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => whenUnlocked(() => $.store.set(key, value)),
      delete: (key) => whenUnlocked(() => $.store.delete(key)),
      keys: () => $.store.keys()
    },
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn)
    },
    session: {
      id: () => $.session.id(),
      root: () => $.session.root(),
      cwd: () => $.session.cwd(),
      model: () => $.session.model(),
      usage: () => $.session.usage(),
      surfaces: () => $.session.surfaces(),
      version: async () => (await $.session.version()).version,
      info: () => $.session.info(),
      messages: (args) => args === undefined ? $.session.messages() : $.session.messages(args),
      append: (args) => $.session.append(args),
      send: (args) => $.session.send(args)
    },
    prompt: { submit: (args) => $.prompt.submit(args) },
    turn: { abort: (args) => $.turn.abort(args) },
    model: { complete: (request, options) => $.model.complete(request, options) },
    command: { register: (command) => $.command.register(command), list: () => $.command.list(), run: (args) => $.command.run(args) },
    tool: { register: (tool) => $.tool.register(tool), call: (input) => $.tool.call(input) },
    agent: {
      list: () => $.agent.list(),
      spawn: (args) => $.agent.spawn(args)
    },
    env: {
      home: () => $.env.get("HOME"),
      dataHome: () => $.env.get("XDG_DATA_HOME"),
      cacheHome: () => $.env.get("XDG_CACHE_HOME"),
      configHome: () => $.env.get("CLAUDE_CONFIG_DIR"),
      browser: () => $.env.get("BROWSER"),
      sshConnection: () => $.env.get("SSH_CONNECTION"),
      display: () => $.env.get("DISPLAY"),
      waylandDisplay: () => $.env.get("WAYLAND_DISPLAY"),
      terminal: async () => ({ program: await $.env.get("TERM_PROGRAM"), ghostty: await $.env.get("GHOSTTY_RESOURCES_DIR"), wezterm: await $.env.get("WEZTERM_EXECUTABLE") })
    },
    device: { read: () => readDevice(claude) },
    cmod: { call: (input) => $.cmod.call(input) }
  };
  const [, answer] = await settledAfterAbort(Promise.all([lifecycle.start(claude, readPlugin), passOn(eventInput)]), passOn.signal);
  return answer;
}
function routeToMod(_$, eventInput, passOn) {
  return lifecycle.route(passOn.event, eventInput, (passed) => passOn(passed), passOn.signal);
}
function routeFailure(_$, eventInput, passOn) {
  return lifecycle.caught(passOn.event, eventInput, (passed) => passOn(passed), passOn);
}
var withCaller = (eventInput, next) => ({ ...eventInput, caller: next.origin.plugin });
var withoutCaller = (next) => (passed) => next(Object.fromEntries(Object.entries(passed).filter(([key]) => key !== "caller")));
function routeCallToMod(_$, eventInput, passOn) {
  return lifecycle.route("cmod.call", withCaller(eventInput, passOn), withoutCaller(passOn), passOn.signal);
}
function routeCallFailure(_$, eventInput, passOn) {
  return lifecycle.caught("cmod.call", withCaller(eventInput, passOn), withoutCaller(passOn), passOn);
}
function registerMod(addHook, definition, options) {
  registerHooks(addHook, definition, options);
  addHook("ui.render", routeToMod).catch(routeFailure);
}
function registerHooks(addHook, definition, options, serve) {
  permissionCheck = undefined;
  registered = definition;
  lifecycle = createLifecycle(definition, () => permissionCheck, options, true, serve);
  addHook("session.start", startMod);
  addHook("classic.Setup", routeToMod).catch(routeFailure);
  addHook("classic.SessionStart", routeToMod).catch(routeFailure);
  addHook("classic.SessionEnd", routeToMod).catch(routeFailure);
  addHook("classic.UserPromptSubmit", routeToMod).catch(routeFailure);
  addHook("classic.UserPromptExpansion", routeToMod).catch(routeFailure);
  addHook("classic.InstructionsLoaded", routeToMod).catch(routeFailure);
  addHook("classic.ConfigChange", routeToMod).catch(routeFailure);
  addHook("classic.DirectoryAdded", routeToMod).catch(routeFailure);
  addHook("classic.PreModelSwitch", routeToMod).catch(routeFailure);
  addHook("classic.PostModelSwitch", routeToMod).catch(routeFailure);
  addHook("classic.PermissionDenied", routeToMod).catch(routeFailure);
  addHook("classic.PostToolUse", routeToMod).catch(routeFailure);
  addHook("classic.PostToolUseFailure", routeToMod).catch(routeFailure);
  addHook("classic.PostToolBatch", routeToMod).catch(routeFailure);
  addHook("classic.MessageDisplay", routeToMod).catch(routeFailure);
  addHook("classic.SubagentStart", routeToMod).catch(routeFailure);
  addHook("classic.SubagentStop", routeToMod).catch(routeFailure);
  addHook("classic.TaskCreated", routeToMod).catch(routeFailure);
  addHook("classic.TaskCompleted", routeToMod).catch(routeFailure);
  addHook("classic.TeammateIdle", routeToMod).catch(routeFailure);
  addHook("classic.Elicitation", routeToMod).catch(routeFailure);
  addHook("classic.ElicitationResult", routeToMod).catch(routeFailure);
  addHook("classic.Notification", routeToMod).catch(routeFailure);
  addHook("classic.PreCompact", routeToMod).catch(routeFailure);
  addHook("classic.PostCompact", routeToMod).catch(routeFailure);
  addHook("classic.Stop", routeToMod).catch(routeFailure);
  addHook("classic.StopFailure", routeToMod).catch(routeFailure);
  addHook("classic.WorktreeCreate", routeToMod).catch(routeFailure);
  addHook("classic.WorktreeRemove", routeToMod).catch(routeFailure);
  addHook("tool.call", routeToMod).catch(routeFailure);
  addHook("prompt.submit", routeToMod).catch(routeFailure);
  addHook("prompt.context", routeToMod).catch(routeFailure);
  addHook("command.run", routeToMod).catch(routeFailure);
  addHook("session.measure", routeToMod).catch(routeFailure);
  addHook("skill.prompt", routeToMod).catch(routeFailure);
  addHook("ui.press", routeToMod).catch(routeFailure);
  addHook("ui.scroll", routeToMod).catch(routeFailure);
  addHook("ui.close", routeToMod).catch(routeFailure);
  addHook("cmod.call", { to: definition.name }, routeCallToMod).catch(routeCallFailure);
  addHook("session.compact", routeToMod).catch(routeFailure);
}

// node_modules/@cmodjs/core/installer.js
var stepId = /^[A-Za-z0-9_-]{1,64}$/;
function checkSteps(name, steps) {
  const seen = new Set;
  for (const step of steps) {
    if (!stepId.test(step.id))
      throw new Error(`${name}: the install step "${step.id}" has no valid id. Use 1 to 64 letters, digits, "_", or "-".`);
    if (step.title.trim() === "")
      throw new Error(`${name}: the install step "${step.id}" needs a title, the line the installer shows above it.`);
    if (seen.has(step.id))
      throw new Error(`${name}: two install steps have the id "${step.id}". Give each step its own id.`);
    seen.add(step.id);
  }
}

// node_modules/@cmodjs/core/mod.js
var sessions = {
  get current() {
    return bound().sessions.current;
  },
  list: (options) => bound().sessions.list(options),
  get: (id) => bound().sessions.get(id),
  search: (text, matcher, options) => bound().sessions.search(text, matcher, options)
};
var settings = {
  user: { read: () => bound().settings.user.read(), update: (values) => bound().settings.user.update(values) },
  project: { read: () => bound().settings.project.read(), update: (values) => bound().settings.project.update(values) },
  local: { read: () => bound().settings.local.read(), update: (values) => bound().settings.local.update(values) },
  beforeChange: (matcherOrListener, listener) => bound().settings.beforeChange(matcherOrListener, listener),
  onChange: (matcherOrListener, listener) => bound().settings.onChange(matcherOrListener, listener)
};
var fs = {
  read: (path) => bound().fs.read(path),
  write: (path, text) => bound().fs.write(path, text),
  exists: (path) => bound().fs.exists(path),
  find: (glob) => bound().fs.find(glob),
  list: (path) => bound().fs.list(path),
  stat: (path, options) => bound().fs.stat(path, options),
  onChange: (matcher, listener) => bound().fs.onChange(matcher, listener)
};
var http = {
  fetch: (url, options) => bound().http.fetch(url, options)
};
var device = {
  read: () => bound().device.read()
};
function defineMod(definition) {
  if (definition.name.trim() === "")
    throw new Error("defineMod: the mod needs a name, such as the name in .claude-plugin/plugin.json.");
  if (definition.options !== undefined)
    checkOptions(definition.name, definition.options);
  if (definition.hotkeys !== undefined)
    checkHotkeys(definition.name, definition.hotkeys);
  if (definition.installer !== undefined)
    checkSteps(definition.name, definition.installer);
  return definition;
}

// node_modules/@cmodjs/core/jobs/context.js
function withinDeadline(mod, deadline, subject, run) {
  return beforeDeadline(engineOf(mod).claude.clock, deadline, subject, () => Promise.resolve().then(run));
}

// node_modules/@cmodjs/core/jobs/slash-command.js
var deadline = { ms: 30000, job: "slashCommand" };
var commandName = /^[A-Za-z0-9_-]{1,64}$/;
function slashCommand(options) {
  const { name, description, argumentHint, immediate, reply } = options;
  return (job) => {
    const { mod, announce, reserveName } = job;
    const { claude, router, report, answerInput } = engineOf(mod);
    if (!commandName.test(name))
      throw new Error(`${mod.name}: "${name}" is not a slash command name. Use 1 to 64 letters, digits, "_", or "-", without the slash.`);
    const reserved = reserveName("slashCommand", name, `${mod.name}: the slash command /${name} is already added. Give each slashCommand its own name.`);
    let registered;
    claude.command.register({ name, description, ...argumentHint === undefined ? {} : { argumentHint }, ...immediate === undefined ? {} : { immediate } }).then(({ command }) => {
      registered = command;
    }, (error) => {
      report({ id: `command:${name}`, message: `/${name} is not added`, error });
    });
    announce(`/${name}`);
    const answering = router.add("command.run", async (e, next) => {
      if (e.command !== registered)
        return next(e);
      try {
        return await answerInput(async () => answerOf(mod.name, await withinDeadline(mod, deadline, `/${name}`, () => reply({ args: e.args, positionals: splitWords(e.args) }, mod))), () => next(e));
      } catch (error) {
        return { text: `/${name} failed: ${oneLine(error)}` };
      }
    });
    return {
      name,
      remove() {
        answering.remove();
        reserved.remove();
      }
    };
  };
}
function answerOf(name, reply) {
  if (reply === undefined)
    return {};
  if (typeof reply === "string")
    return { text: reply };
  return { ...reply.text === undefined ? {} : { text: reply.text }, ...reply.note === undefined ? {} : { context: [modNote(name, reply.note)] } };
}
function splitWords(args) {
  return Dt(args, (key) => `$${key}`).flatMap((entry) => {
    if (typeof entry === "string")
      return [entry];
    if ("comment" in entry)
      return [];
    if (entry.op === "glob")
      return [entry.pattern];
    return [entry.op];
  });
}
function oneLine(error) {
  return messageOf(error).replace(/\s*\n\s*/g, " ");
}

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/src/status.ts
var LOCAL_POOL = "http://127.0.0.1:8317";
async function baseUrlOf() {
  const env = (await settings.user.read())["env"];
  return typeof env === "object" && env !== null ? env["ANTHROPIC_BASE_URL"] : undefined;
}
async function poolOf() {
  const base = await baseUrlOf();
  return typeof base === "string" && base !== "" ? base.replace(/\/+$/, "") : LOCAL_POOL;
}
var resourcesOf = (pool) => `${pool}/v0/resource/plugins/oneclaude`;
var statusUrl = (pool) => `${resourcesOf(pool)}/status.json`;
var usageUrl = (pool) => `${resourcesOf(pool)}/usage.json`;
var dashboardUrl = (pool) => `${pool}/management.html#/plugin-pages/oneclaude/0`;
var addAccountUrl = (pool) => `${pool}/management.html#/oauth`;
var KEY = "management-key";
async function keyOf(mod) {
  const key = await fs.read(`${mod.dataFolder}/${KEY}`).then((text) => text.trim(), () => "");
  return key === "" ? undefined : key;
}
async function saveKey(mod, key) {
  await fs.write(`${mod.dataFolder}/${KEY}`, key);
}
async function manage(mod, key, path, init = {}) {
  const headers = { Authorization: `Bearer ${key}`, ...init.body === undefined ? {} : { "Content-Type": "application/json" } };
  const pool = mod.state.memory.pool;
  const response = await http.fetch(`${pool}/v0/management${path}`, { ...init, headers }).catch((error) => {
    mod.log(`${pool} gave no answer to ${path}: ${String(error)}`);
    return;
  });
  if (response?.status === 401)
    await saveKey(mod, "");
  return response;
}
var PROBLEMS = {
  "proxy-down": "pool unreachable",
  "plugin-off": "plugin off",
  unreadable: "status unreadable"
};
function warningOf(problem, status) {
  return `${PROBLEMS[problem]} since ${momentOf(status.now, new Date().toISOString())}`;
}
async function read(pool, after, device) {
  const query = new URLSearchParams({ ...after === undefined ? {} : { after: String(after) }, ...device === undefined ? {} : { device } }).toString();
  const response = await http.fetch(query === "" ? statusUrl(pool) : `${statusUrl(pool)}?${query}`).catch((error) => String(error));
  if (typeof response === "string")
    return { problem: "proxy-down", cause: response };
  if (response.status === 404)
    return { problem: "plugin-off", cause: "the proxy answered 404" };
  if (!response.ok)
    return { problem: "proxy-down", cause: `the proxy answered ${response.status}` };
  try {
    return { status: JSON.parse(response.text) };
  } catch (error) {
    return { problem: "unreadable", cause: String(error) };
  }
}
async function readBlocks(mod, key) {
  const response = await manage(mod, key, "/auth-files");
  if (response === undefined)
    throw new Error("the proxy did not answer /auth-files");
  if (!response.ok)
    throw new Error(`the proxy answered /auth-files with ${response.status}`);
  const { files } = JSON.parse(response.text);
  const blocks = {};
  for (const file of files ?? []) {
    if (file.provider !== "claude" || file.auth_index === undefined || !file.cooldowns?.length)
      continue;
    blocks[file.auth_index] = file.cooldowns.map((cooldown) => ({
      ...cooldown.scope === "model" && cooldown.model_key !== undefined ? { model: cooldown.model_key } : {},
      until: cooldown.retry_at,
      reason: cooldown.reason
    }));
  }
  return blocks;
}
var BLOCKS = "blocks.json";
var STATUS = "status.json";
async function lastBlocks(mod) {
  return fs.read(`${mod.dataFolder}/${BLOCKS}`).then((text) => JSON.parse(text)).catch(() => {
    return;
  });
}
async function shareStatus(mod, status) {
  await fs.write(`${mod.dataFolder}/${STATUS}`, JSON.stringify(status)).catch((error) => mod.log(`oneclaude could not share the pool's status with the other sessions: ${String(error)}`));
}
async function sharedReading(mod) {
  const status = await fs.read(`${mod.dataFolder}/${STATUS}`).then((text) => JSON.parse(text)).catch(() => null);
  if (status === null)
    return null;
  return { status, blocks: (await lastBlocks(mod))?.blocks ?? {} };
}
async function sharedBlocks(mod, change, isReader) {
  const shared = await lastBlocks(mod);
  if (change !== undefined && shared?.change === change)
    return shared.blocks;
  if (!isReader)
    return;
  const key = await keyOf(mod);
  if (key === undefined)
    return;
  const blocks = await readBlocks(mod, key).catch((error) => {
    mod.log(`oneclaude could not read the proxy's blocks: ${String(error)}`);
    return;
  });
  if (blocks === undefined)
    return;
  await fs.write(`${mod.dataFolder}/${BLOCKS}`, JSON.stringify({ change, blocks })).catch((error) => mod.log(`oneclaude could not share the proxy's blocks with the other sessions: ${String(error)}`));
  return blocks;
}
async function retry(mod, account) {
  const pool = mod.state.memory.pool;
  const key = await keyOf(mod);
  if (key === undefined)
    return "No management key. Enter it in the Install oneclaude tab.";
  const response = await manage(mod, key, "/plugins/oneclaude/retry", { method: "POST", body: JSON.stringify({ auth_index: account.auth_index }) });
  if (response === undefined)
    return `${pool} did not respond.`;
  if (response.ok)
    return;
  if (response.status === 401)
    return "401 Unauthorized: the pool rejected the management key. Enter it in the Install oneclaude tab.";
  if (response.status === 404 && response.text.trim() === "")
    return `404 Not Found: the pool runs oneclaude ${mod.state.memory.reading?.status.version ?? "of another version"}. Reload this session.`;
  return `${response.status}: ${errorOf(response.text)}`;
}
function errorOf(text) {
  try {
    const error = JSON.parse(text).error;
    return typeof error === "string" ? error : text;
  } catch {
    return text;
  }
}
var RATE_LIMITS = ["quota", "credential_quota"];
var LOGINS = ["unauthorized", "invalid_grant"];
function heldOn(account, blocks, now) {
  const held = account.auth_index === undefined ? [] : blocks[account.auth_index] ?? [];
  return held.filter((block) => Date.parse(block.until) > Date.parse(now));
}
function blocksOf(account, blocks, now) {
  return heldOn(account, blocks, now).filter((block) => !RATE_LIMITS.includes(block.reason) && !LOGINS.includes(block.reason));
}
var ACCOUNTS = "accounts";
var rowKey = (account) => `account-${account.name}`;
function troublesOf(status, blocks) {
  const refused = status.accounts.filter((account) => account.refused !== undefined);
  const signedOut = status.accounts.filter((account) => account.refused === undefined && account.signed_out);
  const blocked = status.accounts.filter((account) => account.refused === undefined && !account.signed_out && blocksOf(account, blocks, status.now).length > 0);
  return [
    ...refused.length > 0 ? [{ text: `${plural(refused.length, "account")} refused`, key: rowKey(refused[0]) }] : [],
    ...signedOut.length > 0 ? [{ text: `${plural(signedOut.length, "account")} signed out`, key: rowKey(signedOut[0]) }] : [],
    ...blocked.length > 0 ? [{ text: `${plural(blocked.length, "account")} blocked`, key: rowKey(blocked[0]) }] : [],
    ...status.pool.limit_reached ? [{ text: "agent limit reached", key: ACCOUNTS }] : []
  ];
}
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function clockOf(iso) {
  const at = new Date(iso);
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}
function momentOf(iso, now) {
  const at = new Date(iso);
  const time = clockOf(iso).slice(0, 5);
  return at.toDateString() === new Date(now).toDateString() ? time : `${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`;
}
var FAMILIES = ["opus", "sonnet", "haiku", "fable"];
function percent(fraction) {
  return `${Math.round(fraction * 100)}%`;
}
function pace(ahead) {
  const points = Math.round(Math.abs(ahead) * 100);
  if (points === 0)
    return "on pace";
  return `${points}% ${ahead < 0 ? "under" : "over"} pace`;
}
function paceState(ahead) {
  if (ahead > 0.25)
    return "far-over";
  if (ahead > 0.05)
    return "over";
  if (ahead < -0.05)
    return "under";
  return "on";
}
var NEARLY_EMPTY = 0.95;
var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function evenOf(account, now) {
  if (account.resets_at === undefined)
    return;
  return clamp(1 - (Date.parse(account.resets_at) - Date.parse(now)) / WEEK_MS);
}
function until(iso, now) {
  if (iso === undefined)
    return "unknown";
  const minutes = Math.round((Date.parse(iso) - Date.parse(now)) / 60000);
  if (minutes <= 0)
    return "now";
  if (minutes < 60)
    return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return withRest(`${hours}h`, minutes % 60, "m");
  if (hours < 48)
    return withRest("1d", hours % 24, "h");
  return `${Math.round(minutes / (24 * 60))}d`;
}
function withRest(head, rest, unit) {
  return rest === 0 ? head : `${head} ${rest}${unit}`;
}
function ago(iso, now) {
  const passed = until(now, iso);
  return passed === "now" ? "just now" : `${passed} ago`;
}
var BAR_WIDTH = 22;
var CAP_LEFT = "";
var CAP_RIGHT = "";
function runsOf2(cells) {
  return cells.reduce((runs, cell) => {
    const last = runs.at(-1);
    if (last !== undefined && last.color === cell.color && last.background === cell.background && last.isDim === cell.isDim)
      runs[runs.length - 1] = { ...last, text: last.text + cell.text };
    else
      runs.push(cell);
    return runs;
  }, []);
}
var GLIDE = 0.18;
var FRAME_MS = 33;
var LINE = "line";
var POOL = "pool";
var claudeKey = (account) => `claude:${account.name}`;
var codexKey = (account) => `codex:${account.name}`;
function paceOf(account, now) {
  return account.empty ? account.used : evenOf(account, now) ?? account.used;
}
function barsOf(status) {
  const pool = { used: status.pool.used, pace: status.pool.even };
  const bars = { [LINE]: pool, [POOL]: pool };
  for (const account of status.accounts)
    if (account.known)
      bars[claudeKey(account)] = { used: account.used, pace: paceOf(account, status.now) };
  for (const account of status.codex)
    if (account.known)
      bars[codexKey(account)] = { used: account.used, pace: paceOf(account, status.now) };
  return bars;
}
function glide(shown, target) {
  const step = (from, to) => Math.abs(to - from) < 0.0005 ? to : from + (to - from) * GLIDE;
  return { used: step(shown.used, target.used), pace: step(shown.pace, target.pace) };
}
function clamp(fraction) {
  return Math.min(1, Math.max(0, fraction));
}
function agentsOf(account) {
  return FAMILIES.reduce((sum, family) => sum + (account.agents[family] ?? 0), 0);
}
function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/src/components/pool-bar.tsx
function poolBar({ used, pace }) {
  const isNearlyEmpty = used >= NEARLY_EMPTY;
  const over = Math.max(0, used - pace) * 100;
  return /* @__PURE__ */ h(Progress, {
    width: BAR_WIDTH,
    buffer: pace * 100,
    sections: [{ value: Math.min(used, pace) * 100, tone: isNearlyEmpty ? "critical" : "neutral" }, isNearlyEmpty ? { value: over, color: "diffRemoved" } : { value: over, tone: "warning" }]
  });
}
function drawCells(cells) {
  return cells.map((cell) => /* @__PURE__ */ h(Text, {
    color: cell.color,
    backgroundColor: cell.background,
    dimColor: cell.isDim
  }, cell.text));
}

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/src/components/pool-line.tsx
var PACE_COLORS = {
  on: undefined,
  under: "success",
  over: "claude",
  "far-over": "error"
};
function factText(facts) {
  return facts.map((fact) => typeof fact === "string" ? fact : pace(fact.ahead)).join(" · ");
}
function Facts({ facts, color, wrap = "wrap" }) {
  const draw = (fact) => {
    if (typeof fact === "string")
      return fact;
    const paceColor = PACE_COLORS[paceState(fact.ahead)];
    return paceColor === undefined ? pace(fact.ahead) : /* @__PURE__ */ h(Text, {
      color: paceColor,
      dimColor: false
    }, pace(fact.ahead));
  };
  if (wrap === "wrap") {
    return /* @__PURE__ */ h(Box, {
      flexWrap: "wrap",
      columnGap: 1
    }, facts.map((fact, index) => /* @__PURE__ */ h(Box, {
      flexShrink: 0
    }, /* @__PURE__ */ h(Text, {
      color,
      dimColor: color === undefined
    }, index === 0 ? [draw(fact)] : ["· ", draw(fact)]))));
  }
  const parts = facts.flatMap((fact, index) => index === 0 ? [draw(fact)] : [" · ", draw(fact)]);
  return /* @__PURE__ */ h(Text, {
    color,
    dimColor: color === undefined,
    wrap
  }, parts);
}
function PoolLine({ reading, problem, shown, isOpen, onToggle, onTrouble }) {
  if (reading === null)
    return problem === null ? /* @__PURE__ */ h(Text, {
      dimColor: true
    }, "oneclaude: reading the pool") : /* @__PURE__ */ h(Text, {
      color: "warning"
    }, `oneclaude: ${PROBLEMS[problem]}`);
  const { pool, now } = reading.status;
  const facts = pool.known === 0 ? ["reading accounts", plural(pool.agents, "agent")] : [
    percent(pool.used),
    ...pool.pace === undefined ? [] : [{ ahead: pool.pace }],
    ...pool.next_refill === undefined ? [] : [`next refill in ${until(pool.next_refill, now)}`],
    plural(pool.agents, "agent")
  ];
  return /* @__PURE__ */ h(Box, {
    gap: 2
  }, /* @__PURE__ */ h(Box, {
    flexShrink: 0
  }, poolBar(shown ?? { used: pool.used, pace: pool.even })), /* @__PURE__ */ h(Box, {
    gap: 1
  }, /* @__PURE__ */ h(Facts, {
    facts,
    wrap: "truncate-end"
  }), problem === null ? null : /* @__PURE__ */ h(Box, {
    flexShrink: 0
  }, /* @__PURE__ */ h(Text, {
    color: "warning"
  }, `· ${warningOf(problem, reading.status)}`)), troublesOf(reading.status, reading.blocks).map((trouble) => /* @__PURE__ */ h(Box, {
    flexShrink: 0
  }, /* @__PURE__ */ h(Button, {
    key: `trouble-${trouble.key}`,
    plain: true,
    onPress: () => onTrouble(trouble.key)
  }, /* @__PURE__ */ h(Text, {
    color: "warning"
  }, `· ${trouble.text}`)))), /* @__PURE__ */ h(Box, {
    flexShrink: 0
  }, /* @__PURE__ */ h(Button, {
    key: "accounts",
    dimColor: true,
    onPress: onToggle,
    label: isOpen ? "-" : "+"
  }))));
}

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/src/components/weekly-resets.tsx
var DAYS = 8;
var HOUR_MS = 60 * 60 * 1000;
var DAY_MS = 24 * HOUR_MS;
var WEEK_MS2 = 7 * DAY_MS;
var GAP = 2;
var MOST_CELLS = 8;
var FEWEST_CELLS = 4;
var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var NOW_LINE = "│";
var NOW_COLOR = "text";
function calendarOf(accounts, now, room) {
  const at = Date.parse(now);
  const offset = offsetOf(now);
  const start = at + offset - (at + offset) % DAY_MS - DAY_MS - offset;
  const read = accounts.flatMap((account) => account.known && account.resets_at !== undefined ? [{ account, resets: Date.parse(account.resets_at) }] : []).sort((a, b) => a.resets - b.resets).map(({ account, resets }) => {
    const left = until(account.resets_at, now);
    return { account, resets, reset: left === "now" ? left : `in ${left}`, remaining: account.empty ? "empty" : `${percent(1 - account.used)} left` };
  });
  const resetWidth = Math.max(0, ...read.map(({ reset }) => reset.length));
  const label = resetWidth + GAP + Math.max(0, ...read.map(({ remaining }) => remaining.length));
  const perDay = Math.min(MOST_CELLS, Math.max(FEWEST_CELLS, Math.floor((room - GAP - label) / DAYS)));
  const cellAt = (time) => (time - start) / DAY_MS * perDay;
  const nowCell = Math.floor(cellAt(at));
  const days = Array.from({ length: DAYS }, (_, day) => {
    const date = new Date(start + offset + day * DAY_MS);
    const name = WEEKDAYS[date.getUTCDay()];
    return (perDay > `${name} 00`.length ? `${name} ${date.getUTCDate()}` : name).padEnd(perDay);
  });
  return {
    days: days.join("").trimEnd(),
    now: nowCell,
    lanes: read.map(({ account, resets, reset, remaining }) => {
      const isNearlyEmpty = account.empty || account.used >= NEARLY_EMPTY;
      const opened = resets - WEEK_MS2;
      const open = edgeOf(Math.round(cellAt(opened)), nowCell);
      const close = edgeOf(Math.round(cellAt(resets)), nowCell);
      const runsOut = account.empty ? at : runsOutAt(account.used, opened, at);
      const out = Math.min(close, Math.max(nowCell + 1, Math.round(cellAt(runsOut))));
      return { name: account.name, cells: weekOf({ open, out, close }, nowCell, DAYS * perDay, isNearlyEmpty), reset: reset.padEnd(resetWidth), remaining, isNearlyEmpty };
    })
  };
}
function edgeOf(cell, nowCell) {
  return cell > nowCell ? Math.max(cell, nowCell + 2) : Math.min(cell, nowCell - 1);
}
function runsOutAt(used, opened, now) {
  const pace = used / Math.max(now - opened, HOUR_MS);
  return pace === 0 ? Infinity : now + (1 - used) / pace;
}
function weekOf({ open, out, close }, nowCell, cells, isNearlyEmpty) {
  return runsOf2(Array.from({ length: cells }, (_, cell) => {
    if (cell < open || cell >= close)
      return { text: "╌", color: "inactive", isDim: true };
    const color = cell < nowCell ? "subtle" : isNearlyEmpty ? "error" : "inactive";
    if (cell === nowCell)
      return { text: NOW_LINE, color: NOW_COLOR, background: color };
    const text = cell === open && cell > 0 ? CAP_LEFT : cell === close - 1 && close < cells ? CAP_RIGHT : "█";
    return cell >= out ? { text, color, isDim: true } : { text, color };
  }));
}
function offsetOf(iso) {
  const match = /([+-])(\d\d):(\d\d)$/.exec(iso);
  if (match === null)
    return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === "-" ? -minutes : minutes) * 60000;
}
function WeeklyResets({ calendar, width }) {
  const gap = " ".repeat(GAP);
  const indent = " ".repeat(width + GAP);
  const line = /* @__PURE__ */ h(Text, {
    color: NOW_COLOR
  }, `${indent}${" ".repeat(calendar.now)}${NOW_LINE}`);
  return /* @__PURE__ */ h(Box, {
    flexDirection: "column"
  }, /* @__PURE__ */ h(Text, {
    dimColor: true
  }, `${indent}${calendar.days}`), calendar.lanes.flatMap((lane) => [
    line,
    /* @__PURE__ */ h(Text, null, `${lane.name.padEnd(width)}${gap}`, drawCells(lane.cells), /* @__PURE__ */ h(Text, {
      color: lane.isNearlyEmpty ? "error" : undefined
    }, `${gap}${lane.reset}${gap}`, /* @__PURE__ */ h(Text, {
      dimColor: !lane.isNearlyEmpty
    }, lane.remaining)))
  ]));
}

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/src/usage.ts
var PERIODS = [["quarter", "90 days"], ["month", "30 days"], ["week", "7 days"], ["yesterday", "Yesterday"], ["today", "Today"]];
var BREAKDOWNS = [["account", "Account"], ["model", "Model"], ["agent", "Agent"], ["project", "Project"], ["time", "Time"]];
var UNITS = [["cost", "Cost"], ["tokens", "Tokens"]];
async function readUsage(pool, period, by, units) {
  const response = await http.fetch(`${usageUrl(pool)}?period=${period}&by=${by}&units=${units}`).catch(() => {
    return;
  });
  if (response === undefined || !response.ok)
    return null;
  try {
    const table = JSON.parse(response.text);
    return Array.isArray(table.rows) && Array.isArray(table.days) ? table : null;
  } catch {
    return null;
  }
}
var KINDS = ["input", "output", "cache_write", "cache_read"];
var KIND_TITLES = { input: "Input", output: "Output", cache_write: "Cache write", cache_read: "Cache read" };
var COLD = 0.9;
function totalOf(row, units) {
  const counted = units === "cost" ? row.cost : row.tokens;
  return KINDS.reduce((total, kind) => total + counted[kind], 0);
}
function cachedOf(tokens) {
  const input = tokens.input + tokens.cache_write + tokens.cache_read;
  return input === 0 ? undefined : tokens.cache_read / input;
}
function dayLabel(day) {
  const [, month, date] = day.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${date}`;
}
function money(dollars) {
  if (dollars < 0.005)
    return "$0";
  if (dollars < 1)
    return `$${dollars.toFixed(2)}`;
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}
var COUNT = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
function tokenCount(count) {
  return COUNT.format(count);
}
function amount(value, units) {
  return units === "cost" ? money(value) : tokenCount(value);
}
var GUTTER = "   ";
function usageLayout(table, units, isWide) {
  const grand = totalOf(table.total, units);
  const columns = [
    ...isWide ? KINDS.map((kind) => [KIND_TITLES[kind], (row) => amount((units === "cost" ? row.cost : row.tokens)[kind], units)]) : [],
    ["Cached", (row) => {
      const cached = cachedOf(row.tokens);
      return cached === undefined ? "" : percent(cached);
    }],
    ["Share", (row) => row === table.total ? "" : grand === 0 ? "0%" : percent(totalOf(row, units) / grand)],
    ["Total", (row) => amount(totalOf(row, units), units)]
  ];
  const all = [...table.rows, table.total];
  const labelWidth = Math.max(...all.map((row) => row.label.length));
  const widths = columns.map(([title, cell]) => Math.max(title.length, ...all.map((row) => cell(row).length)));
  const line = (label, cells, cold) => ({
    cells: [label.padEnd(labelWidth), ...cells.map((cell, index) => cell.padStart(widths[index] ?? 0))],
    cold
  });
  const rowLine = (row) => {
    const cached = cachedOf(row.tokens);
    return line(row.label, columns.map(([, cell]) => cell(row)), cached !== undefined && cached < COLD);
  };
  const header = line("", columns.map(([title]) => title), false);
  return { header, rows: table.rows.map(rowLine), total: rowLine(table.total), width: header.cells.join(GUTTER).length };
}
var CHART_ROWS = 4;
var RISERS = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
function dailyChart(table, units) {
  const totals = table.days.map((day) => day.rows.length === 0 ? undefined : day.rows.reduce((sum, row) => sum + totalOf(row, units), 0));
  const peak = Math.max(0, ...totals.map((total) => total ?? 0));
  const eighths = totals.map((total) => total === undefined ? undefined : peak === 0 ? 0 : Math.max(total > 0 ? 1 : 0, Math.round(total / peak * CHART_ROWS * 8)));
  const rows = Array.from({ length: CHART_ROWS }, (_, fromTop) => {
    const floor = (CHART_ROWS - 1 - fromTop) * 8;
    return eighths.map((height) => {
      if (height === undefined)
        return fromTop === CHART_ROWS - 1 ? "·" : " ";
      return RISERS[Math.min(8, Math.max(0, height - floor))] || " ";
    });
  });
  return { peak: amount(peak, units), rows, first: dayLabel(table.days[0]?.day ?? table.today), last: dayLabel(table.days.at(-1)?.day ?? table.today) };
}
function optimizePrompt(pool, agents, projects, models) {
  const lines = (table) => table.rows.filter((row) => totalOf(row, "cost") > 0).slice(0, 12).map((row) => {
    const cached = cachedOf(row.tokens);
    return `- ${row.label}: ${money(totalOf(row, "cost"))} (cache writes ${money(row.cost.cache_write)}, cache reads ${money(row.cost.cache_read)}, output ${money(row.cost.output)}, input ${money(row.cost.input)}), ${tokenCount(totalOf(row, "tokens"))} tokens${cached === undefined ? "" : `, ${percent(cached)} from cache`}`;
  });
  return [
    "Optimize my Claude usage: find where it can cost less without losing quality. These are oneclaude's numbers for the last 30 days, at API list prices.",
    "",
    'By agent type ("Main sessions" are the sessions I talk to):',
    ...lines(agents),
    "",
    "By project:",
    ...lines(projects),
    "",
    "By model:",
    ...lines(models),
    "",
    `Any period and breakdown: ${usageUrl(pool)}?period=month&by=agent (period quarter, month, week, yesterday or today; by account, model, agent, project or time).`,
    "",
    "Read the agent definitions, Skills and settings behind the most expensive rows, find what drives their cache writes and their output, and propose changes ranked by what each would save per day. Change nothing until I approve."
  ].join(`
`);
}

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/src/pages/accounts.tsx
var COMBINED = "Combined usage";
var GAP2 = 2;
var INSET = 3;
var CONTROL = 7;
async function showUsage(mod, change = {}) {
  const view = { ...mod.state.memory.usage, ...change };
  mod.state.memory.usage = view;
  const table = await readUsage(mod.state.memory.pool, view.period, view.by, view.units);
  const { period, by, units } = mod.state.memory.usage;
  if (table !== null && period === view.period && by === view.by && units === view.units)
    mod.state.memory.table = table;
}
var LOG_SHOWN = 10;
var accountsPage = {
  id: "accounts",
  title: "Accounts",
  render: (mod, { columns }) => {
    const { reading, problem } = mod.state.memory;
    if (reading === null)
      return problem === null ? /* @__PURE__ */ h(Text, {
        dimColor: true
      }, "Reading your accounts") : /* @__PURE__ */ h(Text, {
        color: "warning"
      }, `oneclaude: ${PROBLEMS[problem]}`);
    const { status, blocks } = reading;
    const shown = mod.state.memory.shown;
    const combined = combinedRow(status, shown[POOL]);
    const claude = status.accounts.map((account) => claudeRow(mod, account, blocks, status.now, shown[claudeKey(account)]));
    const codex = status.codex.map((account) => codexRow(account, status.now, shown[codexKey(account)]));
    const rows = [combined, ...claude, ...codex];
    const width = Math.max(...rows.map((row) => row.name.length));
    const isNarrow = rows.some((row) => INSET * 2 + width + GAP2 + BAR_WIDTH + GAP2 + factText(row.facts).length > columns);
    const draw = (row) => /* @__PURE__ */ h(RowView, {
      row,
      width,
      isNarrow
    });
    return /* @__PURE__ */ h(Box, {
      flexDirection: "column",
      gap: 1,
      paddingX: 1
    }, problem === null ? null : /* @__PURE__ */ h(Box, {
      paddingX: 2
    }, /* @__PURE__ */ h(Text, {
      color: "warning"
    }, warningOf(problem, status))), /* @__PURE__ */ h(Box, {
      borderStyle: "round",
      borderDimColor: true,
      paddingX: 1,
      flexDirection: "column"
    }, draw(combined)), /* @__PURE__ */ h(Section, {
      key: ACCOUNTS,
      title: "Claude accounts"
    }, claude.map(draw)), codex.length > 0 ? /* @__PURE__ */ h(Section, {
      title: "Codex accounts"
    }, codex.map(draw)) : null, /* @__PURE__ */ h(ResetsSection, {
      accounts: status.accounts,
      now: status.now,
      width,
      columns: columns - INSET * 2
    }), /* @__PURE__ */ h(UsageSection, {
      mod,
      table: mod.state.memory.table,
      view: mod.state.memory.usage,
      columns: columns - INSET * 2
    }), mod.state.memory.table === null ? null : /* @__PURE__ */ h(ChartSection, {
      table: mod.state.memory.table,
      view: mod.state.memory.usage
    }), status.log.length === 0 ? null : /* @__PURE__ */ h(LogSection, {
      log: status.log
    }), /* @__PURE__ */ h(Box, {
      paddingX: 2,
      gap: 2
    }, /* @__PURE__ */ h(Button, {
      key: "open-dashboard",
      dimColor: true,
      href: dashboardUrl(mod.state.memory.pool),
      label: "Open dashboard"
    }), /* @__PURE__ */ h(Button, {
      key: "add-account",
      dimColor: true,
      href: addAccountUrl(mod.state.memory.pool),
      label: "Add account"
    })));
  }
};
function Section({ key, title, children }) {
  return /* @__PURE__ */ h(Box, {
    key,
    flexDirection: "column",
    gap: 1,
    paddingX: 2
  }, /* @__PURE__ */ h(Text, {
    bold: true
  }, title), /* @__PURE__ */ h(Box, {
    flexDirection: "column",
    gap: 1
  }, children));
}
function ResetsSection({ accounts, now, width, columns }) {
  const calendar = calendarOf(accounts, now, columns - width - GAP2);
  if (calendar.lanes.length === 0)
    return null;
  return /* @__PURE__ */ h(Section, {
    title: "Weekly resets"
  }, [/* @__PURE__ */ h(WeeklyResets, {
    calendar,
    width
  })]);
}
function RowView({ row, width, isNarrow }) {
  return /* @__PURE__ */ h(Box, {
    key: row.key,
    gap: GAP2
  }, /* @__PURE__ */ h(Box, {
    flexShrink: 0,
    minWidth: width
  }, /* @__PURE__ */ h(Text, null, row.name)), /* @__PURE__ */ h(Box, {
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0
  }, rowBody(row, isNarrow)));
}
function rowBody(row, isNarrow) {
  if (row.shown === undefined) {
    return [
      /* @__PURE__ */ h(Box, {
        gap: GAP2
      }, row.facts.length === 0 ? null : /* @__PURE__ */ h(Facts, {
        facts: row.facts,
        color: row.color
      }), row.trouble ?? null)
    ];
  }
  const bar = /* @__PURE__ */ h(Box, {
    flexShrink: 0
  }, poolBar(row.shown));
  const [first, ...rest] = row.facts;
  const lines = isNarrow ? [/* @__PURE__ */ h(Box, {
    gap: GAP2
  }, bar, /* @__PURE__ */ h(Facts, {
    facts: first === undefined ? [] : [first],
    color: row.color
  })), /* @__PURE__ */ h(Facts, {
    facts: rest,
    color: row.color
  })] : [/* @__PURE__ */ h(Box, {
    gap: GAP2
  }, bar, /* @__PURE__ */ h(Facts, {
    facts: row.facts,
    color: row.color
  }))];
  return row.trouble === undefined ? lines : [...lines, row.trouble];
}
function combinedRow(status, shown) {
  const { pool, now } = status;
  const unread = pool.accounts - pool.known;
  return {
    name: COMBINED,
    shown: shown ?? { used: pool.used, pace: pool.even },
    facts: [
      percent(pool.used),
      ...pool.pace === undefined ? [] : [{ ahead: pool.pace }],
      ...pool.next_refill === undefined ? [] : [`next refill in ${until(pool.next_refill, now)} frees ${percent(pool.refill_gain)}`],
      plural(pool.agents, "agent"),
      ...unread > 0 ? [`${plural(unread, "account")} not read yet`] : []
    ]
  };
}
function claudeRow(mod, account, blocks, now, shown) {
  const key = rowKey(account);
  if (account.refused !== undefined) {
    return { key, name: account.name, facts: [], trouble: /* @__PURE__ */ h(TroubleView, {
      text: "refused"
    }, /* @__PURE__ */ h(RetryButton, {
      mod,
      account
    })) };
  }
  if (account.signed_out) {
    return { key, name: account.name, facts: [], trouble: /* @__PURE__ */ h(TroubleView, {
      text: "signed out"
    }, /* @__PURE__ */ h(Button, {
      key: `sign-in-${account.name}`,
      dimColor: true,
      href: addAccountUrl(mod.state.memory.pool),
      label: "Sign in"
    })) };
  }
  const last = blocksOf(account, blocks, now).map((block) => block.until).sort().at(-1);
  const trouble = last === undefined ? undefined : /* @__PURE__ */ h(TroubleView, {
    text: `blocked until ${momentOf(last, now)}`
  }, /* @__PURE__ */ h(RetryButton, {
    mod,
    account
  }));
  if (!account.known)
    return { key, name: account.name, facts: ["not read yet"], trouble };
  const agents = FAMILIES.filter((family) => (account.agents[family] ?? 0) > 0).map((family) => `${account.agents[family]} ${family}`);
  return {
    key,
    name: account.name,
    shown: shown ?? { used: account.used, pace: paceOf(account, now) },
    color: account.empty ? "error" : undefined,
    facts: [
      ...usageFacts(account, now),
      ...account.throttled_at === undefined ? [] : [`throttled ${ago(account.throttled_at, now)}`],
      agentsOf(account) === 0 ? "idle" : agents.join(", "),
      ...account.projected ? ["refilled since its last reading"] : []
    ],
    trouble
  };
}
function TroubleView({ text, children }) {
  return /* @__PURE__ */ h(Box, {
    gap: 2
  }, /* @__PURE__ */ h(Text, {
    color: "warning"
  }, text), children);
}
function RetryButton({ mod, account }) {
  const press = async () => {
    const failure = await retry(mod, account);
    if (failure !== undefined)
      mod.toast.error(`Could not clear ${account.name}'s blocks`, { description: failure });
  };
  return /* @__PURE__ */ h(Button, {
    key: `retry-${account.name}`,
    dimColor: true,
    onPress: press,
    label: "Retry"
  });
}
function codexRow(account, now, shown) {
  if (!account.known)
    return { name: account.name, facts: ["not read yet"] };
  return {
    name: account.name,
    shown: shown ?? { used: account.used, pace: paceOf(account, now) },
    color: account.empty ? "error" : undefined,
    facts: [
      ...usageFacts(account, now),
      ...account.projected ? ["refilled since its last reading"] : []
    ]
  };
}
function usageFacts(account, now) {
  const even = evenOf(account, now);
  return [
    account.empty ? "empty" : percent(account.used),
    ...account.empty || even === undefined ? [] : [{ ahead: account.used - even }],
    `refills in ${until(account.resets_at, now)}`
  ];
}
function Choices({ name, choices, chosen, onChoose }) {
  return /* @__PURE__ */ h(Box, {
    gap: 1
  }, /* @__PURE__ */ h(Box, {
    flexShrink: 0,
    minWidth: CONTROL
  }, /* @__PURE__ */ h(Text, {
    dimColor: true
  }, name)), /* @__PURE__ */ h(Tabs, {
    tabs: choices.map(([key, label]) => ({ key, label })),
    selected: chosen,
    onSelect: (key) => onChoose(key)
  }));
}
function TableRow({ line, isHeader = false, isTotal = false }) {
  const last = line.cells.length - 1;
  const cached = last - 2;
  const cells = line.cells.map((cell, index) => {
    const text = index === 0 ? cell : `${GUTTER}${cell}`;
    if (isHeader)
      return text;
    if (index === last)
      return /* @__PURE__ */ h(Text, {
        color: "claude"
      }, text);
    if (index === cached && line.cold)
      return /* @__PURE__ */ h(Text, {
        color: "warning"
      }, text);
    return text;
  });
  return /* @__PURE__ */ h(Text, {
    dimColor: isHeader,
    bold: isTotal
  }, cells);
}
function UsageSection({ mod, table, view, columns }) {
  if (table === null)
    return /* @__PURE__ */ h(Section, {
      title: "Usage"
    }, [/* @__PURE__ */ h(Text, {
      dimColor: true
    }, "Reading the request log")]);
  const wide = usageLayout(table, view.units, true);
  const layout = wide.width <= columns ? wide : usageLayout(table, view.units, false);
  const isUnrecorded = (view.by === "agent" || view.by === "project") && table.rows.some((row) => row.key === "");
  return /* @__PURE__ */ h(Section, {
    key: "usage",
    title: "Usage"
  }, [
    /* @__PURE__ */ h(Box, {
      flexDirection: "column"
    }, /* @__PURE__ */ h(Choices, {
      name: "Period",
      choices: PERIODS,
      chosen: view.period,
      onChoose: (period) => void showUsage(mod, { period })
    }), /* @__PURE__ */ h(Choices, {
      name: "By",
      choices: BREAKDOWNS,
      chosen: view.by,
      onChoose: (by) => void showUsage(mod, { by })
    }), /* @__PURE__ */ h(Choices, {
      name: "Show",
      choices: UNITS,
      chosen: view.units,
      onChoose: (units) => void showUsage(mod, { units })
    })),
    /* @__PURE__ */ h(Box, {
      flexDirection: "column"
    }, /* @__PURE__ */ h(TableRow, {
      line: layout.header,
      isHeader: true
    }), layout.rows.map((line) => /* @__PURE__ */ h(TableRow, {
      line
    })), /* @__PURE__ */ h(TableRow, {
      line: layout.total,
      isTotal: true
    })),
    ...isUnrecorded ? [/* @__PURE__ */ h(Text, {
      dimColor: true,
      wrap: "wrap"
    }, "Not recorded: requests from before oneclaude recorded agent types and projects, and from conversations whose record never reached the pool.")] : [],
    /* @__PURE__ */ h(Optimize, {
      mod
    })
  ]);
}
function Optimize({ mod }) {
  if (!mod.state.memory.isConfirming) {
    return /* @__PURE__ */ h(Box, null, /* @__PURE__ */ h(Button, {
      key: "optimize",
      dimColor: true,
      onPress: () => {
        mod.state.memory.isConfirming = true;
      },
      label: "Optimize usage"
    }));
  }
  const send = async () => {
    const [agents, projects, models] = await Promise.all(["agent", "project", "model"].map((by) => readUsage(mod.state.memory.pool, "month", by, "cost")));
    mod.state.memory.isConfirming = false;
    if (!agents || !projects || !models) {
      mod.toast.error("oneclaude could not read the usage, so nothing was sent");
      return;
    }
    await sessions.current.send({ type: Prompt, text: optimizePrompt(mod.state.memory.pool, agents, projects, models) });
  };
  return /* @__PURE__ */ h(Box, {
    flexDirection: "column"
  }, /* @__PURE__ */ h(Text, {
    bold: true
  }, "Ask your agent to optimize your usage?"), /* @__PURE__ */ h(Text, {
    dimColor: true,
    wrap: "wrap"
  }, "We'll send it your last 30 days of usage, by agent, project and model."), /* @__PURE__ */ h(Box, {
    gap: 2
  }, /* @__PURE__ */ h(Button, {
    key: "optimize-send",
    variant: "primary",
    onPress: send,
    label: "Ask your agent"
  }), /* @__PURE__ */ h(Button, {
    key: "optimize-cancel",
    dimColor: true,
    onPress: () => {
      mod.state.memory.isConfirming = false;
    },
    label: "Cancel"
  })));
}
function ChartSection({ table, view }) {
  const chart = dailyChart(table, view.units);
  const pad = " ".repeat(chart.peak.length);
  const span = chart.rows[0].length * 2 - 1;
  return /* @__PURE__ */ h(Section, {
    title: "Usage per day, last 30 days"
  }, [
    /* @__PURE__ */ h(Box, {
      flexDirection: "column"
    }, chart.rows.map((cells, index) => /* @__PURE__ */ h(Text, null, /* @__PURE__ */ h(Text, {
      dimColor: true
    }, index === 0 ? chart.peak : pad), GUTTER, cells.map((cell, day) => {
      const text = day === 0 ? cell : ` ${cell}`;
      if (cell === "·")
        return /* @__PURE__ */ h(Text, {
          dimColor: true
        }, text);
      return cell === " " ? text : /* @__PURE__ */ h(Text, {
        color: "claude"
      }, text);
    }))), /* @__PURE__ */ h(Text, {
      dimColor: true
    }, `${pad}${GUTTER}${chart.first}${chart.last.padStart(span - chart.first.length)}`))
  ]);
}
function LogSection({ log }) {
  const shown = [...log].reverse().slice(0, LOG_SHOWN);
  return /* @__PURE__ */ h(Section, {
    key: "log",
    title: "Log"
  }, [
    /* @__PURE__ */ h(Box, {
      flexDirection: "column"
    }, shown.map((entry) => /* @__PURE__ */ h(Box, {
      gap: 2
    }, /* @__PURE__ */ h(Box, {
      flexShrink: 0
    }, /* @__PURE__ */ h(Text, {
      dimColor: true
    }, clockOf(entry.at))), /* @__PURE__ */ h(Box, {
      flexShrink: 0
    }, /* @__PURE__ */ h(Text, {
      color: entry.level === "WARN" ? "warning" : undefined,
      dimColor: entry.level === "INFO"
    }, entry.level)), /* @__PURE__ */ h(Text, {
      wrap: "wrap"
    }, entry.text))), log.length > LOG_SHOWN ? /* @__PURE__ */ h(Text, {
      dimColor: true
    }, `${plural(log.length - LOG_SHOWN, "earlier line")} on the dashboard`) : null)
  ]);
}

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/src/record.ts
function checked(input) {
  const { name, url, responses, timeoutSeconds, failOpen, observabilityMode } = input;
  if (typeof name !== "string" || name === "")
    throw new Error("a filter needs its mod's name");
  if (typeof url !== "string" || url === "")
    throw new Error(`the ${name} filter needs its url`);
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120))
    throw new Error(`the ${name} filter's timeoutSeconds must be a whole number from 1 to 120`);
  return {
    name,
    url,
    ...responses === true ? { responses } : {},
    ...timeoutSeconds === undefined ? {} : { timeoutSeconds },
    ...failOpen === true ? { failOpen } : {},
    ...observabilityMode === true ? { observabilityMode } : {}
  };
}
function recordOf2(mod) {
  let filters = [];
  let agents = {};
  let taken;
  let line = { session: "", last: Promise.resolve(undefined) };
  const post = async (session) => {
    const key = await keyOf(mod);
    if (key === undefined)
      return;
    const body = JSON.stringify({ session, project: sessions.current.project, agents, filters });
    const sent = `${mod.state.memory.pool} ${body}`;
    if (sent === taken)
      return;
    const response = await manage(mod, key, "/plugins/oneclaude/session", { method: "POST", body });
    if (response === undefined || response.ok) {
      if (response?.ok === true)
        taken = sent;
      return;
    }
    mod.log(`the pool refused the record of session ${session} with ${response.status}: ${response.text}`);
    return response.status === 400 ? JSON.parse(response.text).error ?? response.text : undefined;
  };
  const send = () => {
    const session = sessions.current.id;
    if (line.session !== session)
      line = { session, last: Promise.resolve(undefined) };
    const current = line;
    const start = () => {
      current.next = undefined;
      return post(session);
    };
    current.next ??= current.last.then(start, start);
    current.last = current.next;
    return current.next;
  };
  const change = async (next) => {
    if (JSON.stringify(next) === JSON.stringify(filters))
      return;
    const before = filters;
    filters = next;
    const refusal = await send();
    if (refusal !== undefined) {
      filters = before;
      throw new Error(refusal);
    }
  };
  return {
    addFilter: async (input) => {
      const filter = checked(input);
      const at = filters.findIndex((saved) => saved.name === filter.name);
      await change(at === -1 ? [...filters, filter] : filters.with(at, filter));
    },
    removeFilter: async ({ name }) => change(filters.filter((saved) => saved.name !== name)),
    addAgent: async (id, agentType) => {
      if (agents[id] === agentType)
        return;
      agents = { ...agents, [id]: agentType };
      await send();
    },
    send: async () => {
      await send();
    }
  };
}

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/src/state.ts
var initialState = {
  memory: { pool: LOCAL_POOL, reading: null, problem: null, isOpen: false, shown: {}, usage: { period: "month", by: "account", units: "cost" }, table: null, isConfirming: false, keyAnswer: null }
};

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/src/mod.tsx
var RETRY_MS = [1000, 2000, 4000, 8000, 16000];
async function checkKey(mod, key) {
  mod.state.memory.pool = await poolOf();
  const response = await http.fetch(`${mod.state.memory.pool}/v0/management/plugins/oneclaude/status`, { headers: { Authorization: `Bearer ${key}` } }).catch(() => {
    return;
  });
  if (response?.ok === true)
    await saveKey(mod, key);
  mod.state.memory.keyAnswer = response?.ok === true ? "saved" : response?.status === 401 ? "wrong" : "unanswered";
}
var askKey = {
  id: "management-key",
  title: "CLIProxyAPI's management key",
  render: (mod) => /* @__PURE__ */ h(Box, {
    flexDirection: "column"
  }, /* @__PURE__ */ h(Text, null, "oneclaude reads and clears the proxy's blocks, and tells it each session's project, agents and filters, with the management key you set for CLIProxyAPI."), /* @__PURE__ */ h(Input, {
    key: "management-key",
    label: "› ",
    submitLabel: "save",
    onSubmit: (key) => void checkKey(mod, key)
  }), mod.state.memory.keyAnswer === "saved" ? /* @__PURE__ */ h(Text, {
    color: "success"
  }, "✔ saved") : mod.state.memory.keyAnswer === "wrong" ? /* @__PURE__ */ h(Text, {
    color: "error"
  }, "The proxy at ", mod.state.memory.pool, " refused that key.") : mod.state.memory.keyAnswer === "unanswered" ? /* @__PURE__ */ h(Text, {
    color: "error"
  }, "The proxy at ", mod.state.memory.pool, " didn't answer.") : /* @__PURE__ */ h(Text, null, "")),
  isDone: async (mod) => await keyOf(mod) !== undefined
};
var oneclaude = defineMod({
  name: "oneclaude",
  state: initialState,
  installer: [askKey],
  async setup(mod) {
    const page = mod.pages.add(accountsPage);
    let frames;
    const settle = () => {
      frames?.stop();
      frames = undefined;
    };
    const frame = () => {
      const reading = mod.state.memory.reading;
      if (reading === null)
        return settle();
      const shown = {};
      let isMoving = false;
      for (const [key, target] of Object.entries(barsOf(reading.status))) {
        const next = glide(mod.state.memory.shown[key] ?? target, target);
        shown[key] = next;
        isMoving ||= next.used !== target.used || next.pace !== target.pace;
      }
      mod.state.memory.shown = shown;
      if (!isMoving)
        settle();
    };
    const animate = () => {
      frames ??= mod.every(FRAME_MS, frame);
    };
    let isUsingProxy = false;
    const useProxy = async () => {
      if (isUsingProxy)
        return;
      isUsingProxy = true;
      if (await baseUrlOf() === undefined)
        await settings.user.update({ env: { ANTHROPIC_BASE_URL: LOCAL_POOL } });
    };
    const record = recordOf2(mod);
    let blocksShown;
    let blocksWanted = { change: undefined, isReader: false };
    let isReadingBlocks = false;
    const showBlocks = async (status) => {
      const isReader = status.reads_blocks === true || status.blocks_change === undefined;
      blocksWanted = { change: status.blocks_change, isReader: isReader || blocksWanted.change === status.blocks_change && blocksWanted.isReader };
      if (isReadingBlocks)
        return;
      isReadingBlocks = true;
      try {
        while (blocksShown === undefined || blocksShown.change !== blocksWanted.change) {
          const wanted = blocksWanted;
          const blocks = await sharedBlocks(mod, wanted.change, wanted.isReader);
          if (blocks === undefined)
            return;
          const reading = mod.state.memory.reading;
          if (reading !== null)
            mod.state.memory.reading = { ...reading, blocks };
          blocksShown = { change: wanted.change, blocks };
        }
      } finally {
        isReadingBlocks = false;
      }
    };
    let usageReading;
    const draw = (status) => {
      mod.state.memory.problem = null;
      mod.state.memory.reading = { status, blocks: blocksShown?.blocks ?? mod.state.memory.reading?.blocks ?? {} };
      animate();
      shareStatus(mod, status);
      showBlocks(status);
      record.send();
      useProxy();
      mod.state.memory.isOpen = page.isOpen;
      if (page.isOpen)
        usageReading ??= showUsage(mod).finally(() => {
          usageReading = undefined;
        });
    };
    const machine = device.read().then(({ id }) => id, (error) => {
      mod.log(`oneclaude names no machine to the pool, so this session reads every blocks change itself: ${String(error)}`);
      return;
    });
    const ask = async (after) => {
      const pool = await poolOf();
      mod.state.memory.pool = pool;
      const within = mod.state.memory.reading?.status.answers_within_ms;
      const silence = within === undefined ? undefined : mod.after(within, () => {
        mod.log(`${pool} sent no status within ${within} ms`);
        mod.state.memory.problem = "proxy-down";
      });
      const answer = await read(pool, after, await machine).finally(() => silence?.stop());
      if (!("problem" in answer))
        return answer.status;
      mod.log(`${pool} brought no status: ${answer.cause}`);
      mod.state.memory.problem = answer.problem;
      return;
    };
    const pause = (ms) => new Promise((resolve) => void mod.after(ms, resolve));
    const follow = async () => {
      let after;
      let failures = 0;
      for (;; ) {
        const status = await ask(after).catch((error) => {
          mod.log(`oneclaude could not ask the pool for its status: ${String(error)}`);
          return;
        });
        if (status === undefined) {
          after = undefined;
          await pause(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
          continue;
        }
        failures = 0;
        after = status.change;
        draw(status);
        if (after === undefined)
          await pause(RETRY_MS[0]);
      }
    };
    const toggle = async () => {
      if (!page.isOpen) {
        mod.state.memory.isConfirming = false;
        showUsage(mod);
        mod.state.memory.shown = Object.fromEntries(Object.entries(mod.state.memory.shown).map(([key, shown]) => [key, key === LINE ? shown : { used: 0, pace: 0 }]));
        animate();
      }
      await page.toggle({ focus: true });
      mod.state.memory.isOpen = page.isOpen;
    };
    const showTrouble = async (key) => {
      if (!page.isOpen)
        await toggle();
      await page.scrollTo({ key }, { block: "start" });
    };
    mod.widgets.add({
      id: "pool",
      title: "Pool usage",
      areas: [BelowPrompt, Dashboard],
      render: (current) => /* @__PURE__ */ h(PoolLine, {
        reading: current.state.memory.reading,
        problem: current.state.memory.problem,
        shown: current.state.memory.shown[LINE],
        isOpen: current.state.memory.isOpen,
        onToggle: toggle,
        onTrouble: showTrouble
      })
    });
    mod.use(slashCommand({
      name: "accounts",
      description: "Show every Claude account: combined usage, pace, agents and the log",
      reply: toggle
    }));
    sessions.current.onTaskStart((task) => {
      if (task.owner.agentType !== undefined)
        record.addAgent(task.id, task.owner.agentType);
    });
    const start = async () => {
      const shared = await sharedReading(mod);
      mod.state.memory.reading ??= shared;
      mod.state.memory.pool = await poolOf();
      record.send();
    };
    sessions.current.onSessionStart({ source: /^(clear|resume|fork)$/ }, start);
    sessions.current.onCwdChange(() => void record.send());
    await start();
    follow();
    return {
      addFilter: (input) => record.addFilter(input),
      removeFilter: (input) => record.removeFilter(input)
    };
  }
});

// ../../../../../private/var/folders/q2/p1t6rgxj5fj32g1dc7dmd49r0000gn/T/cmod-publish-oneclaude-gOUZJs/release/hooks/register.ts
function register(addHook, options) {
  registerMod(addHook, oneclaude, options);
}
export {
  register
};
