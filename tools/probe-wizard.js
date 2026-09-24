// 定位 fnpack 对 wizard JSON 的校验规则：逐步替换字段类型，找出不合法的部分
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "fnos");
const FNPACK = path.join(ROOT, ".tools", "fnpack.exe");

const VARIANTS = {
  empty: [],
  text: [
    {
      stepTitle: "S",
      items: [{ type: "text", field: "wizard_a", label: "A", initValue: "", rules: [{ required: true, message: "x" }] }]
    }
  ],
  tips: [{ stepTitle: "S", items: [{ type: "tips", helpText: "hello" }] }],
  password: [
    {
      stepTitle: "S",
      items: [{ type: "password", field: "wizard_b", label: "B", initValue: "", rules: [] }]
    }
  ],
  switch_false: [{ stepTitle: "S", items: [{ type: "switch", field: "wizard_c", label: "C", initValue: false }] }],
  switch_str: [{ stepTitle: "S", items: [{ type: "switch", field: "wizard_c", label: "C", initValue: "false" }] }],
  select: [
    {
      stepTitle: "S",
      items: [
        {
          type: "select",
          field: "wizard_d",
          label: "D",
          initValue: "auto",
          options: [
            { label: "跟随系统", value: "auto" },
            { label: "明月", value: "moonlight" }
          ]
        }
      ]
    }
  ],
  pattern: [
    {
      stepTitle: "S",
      items: [
        {
          type: "text",
          field: "wizard_e",
          label: "E",
          initValue: "",
          rules: [{ pattern: "^$|^https?://.+$", message: "bad" }]
        }
      ]
    }
  ],
  three_steps: [
    { stepTitle: "S1", items: [{ type: "text", field: "wizard_f", label: "F", initValue: "x", rules: [] }] },
    { stepTitle: "S2", items: [{ type: "text", field: "wizard_g", label: "G", initValue: "y", rules: [] }] },
    { stepTitle: "S3", items: [{ type: "select", field: "wizard_h", label: "H", initValue: "a", options: [{ label: "a", value: "a" }] }] }
  ]
};

function tryVariant(name, value, attempt) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fpkwiz-"));
  const dest = path.join(tmp, "fnos");
  fs.cpSync(SRC, dest, { recursive: true, force: true });
  fs.writeFileSync(path.join(dest, "wizard", "install"), JSON.stringify(value, null, 2));
  let out = "";
  try {
    out = execFileSync(FNPACK, ["build", "--directory", dest], { cwd: tmp, encoding: "utf8" });
    const ok = out.includes("Packing successfully");
    console.log((ok ? "PASS" : "FAIL") + "  " + name + (ok ? "" : "  -> " + out.replace(/\s+/g, " ").trim().slice(0, 160)));
    return ok;
  } catch (e) {
    const msg = String(e.stdout || e.message);
    if (attempt < 3 && msg.includes("EBUSY")) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return tryVariant(name, value, (attempt || 0) + 1);
    }
    console.log("FAIL  " + name + "  -> " + msg.replace(/\s+/g, " ").trim().slice(0, 160));
    return false;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

for (const [name, value] of Object.entries(VARIANTS)) {
  tryVariant(name, value, 0);
}
