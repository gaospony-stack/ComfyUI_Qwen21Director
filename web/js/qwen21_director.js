/**
 * Qwen 2.1 Director — visual parameter panel.
 *
 * Replaces the raw `panel` JSON textarea with a compact form: mode + reference
 * image side by side, prompts, size, sampler and acceleration switches.
 * All values are written back into the `panel` widget so they serialize with
 * the workflow as usual.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/**
 * 拼接口地址。
 *
 * 写死 "/view" 这种根路径的话，ComfyUI 被反代挂到子路径
 * （https://域名/comfy/）时请求会打到域名根，参考图预览、上传、
 * 目录列表全部 404。统一交给 api.apiURL() 补上 basePath；
 * 老版本没有这个方法时原样返回，不影响正常部署。
 */
function apiUrl(path) {
    try {
        if (api && typeof api.apiURL === "function") return api.apiURL(path);
    } catch {
        /* 取不到就退回原路径 */
    }
    return path;
}

const PANEL_NODE = "Qwen21Director";
const DOM_WIDGET = "panel_ui";

// 面板宽度必须写死。
// DOM widget 的宿主元素是"内容自适应"宽度：里面 8 个比例按钮的 min-width
// 加起来约 325px，面板就跟着变成 ~357px，节点右边空出一大块；
// 而一旦某次布局测量到更宽的内容，节点宽度还会跟着跳（正反馈）。
// 所以：内容写死 520px，节点写死 560px，两者对齐，宽度永远不变。
const PANEL_NODE_W = 560;      // 节点初始宽度（之后可自由拖动，内容自动跟随）
const PANEL_WIDE_W = 1240;     // wide 布局：固定宽度，不允许缩放
const PANEL_WIDE_H = 1052;     // wide 布局：固定高度，不允许缩放（右栏要放下 4 张卡 + 使用说明）
const PANEL_OVERHEAD = 34;     // 节点标题栏 + widget 外边距（实测约 34px）

const OPTIONAL_INPUTS = {
    model: "MODEL",
    clip: "CLIP",
    vae: "VAE",
    image: "IMAGE",
};

const ASPECTS = [
    ["1:1", "1:1"], ["3:2", "3:2"], ["2:3", "2:3"], ["4:3", "4:3"],
    ["3:4", "3:4"], ["16:9", "16:9"], ["9:16", "9:16"], ["21:9", "21:9"],
];
// 2.25 MP 是特意放的：16:9 时正好是 2048×1152，无需 32 对齐修正。
const MEGAPIXELS = [0.5, 0.75, 1.0, 1.5, 2.0, 2.25, 3.0, 4.0];

const FONT_FAMILY = "'Noto Sans SC', 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif";
const FONT = `11.5px/1.45 ${FONT_FAMILY}`;

/* 色调取自参考图像素聚类：底 #04142d / 卡片 #0c1e39 / 强调 #3672ee / 次级文字 #788aba。
 * 面板没有样式表，颜色全部内联；只有需要 :hover / :focus / ::-webkit-slider-*
 * 这类伪类的部分才注入一小段 CSS（见 ensurePanelCss）。 */
const THEME = {
    bg:         "#061226",   // 面板底（最暗的一层）
    cardBg:     "#0c1e39",   // 卡片
    cardBorder: "#1b3157",   // 卡片描边
    inputBg:    "#08162e",   // 输入框 / 下拉 / 文本域
    inputBorder:"#1d3559",
    hover:      "#132a4d",   // 悬停态
    text:       "#dbe6fb",   // 正文
    label:      "#8ea3c7",   // 行标签
    muted:      "#63789b",   // 次要说明
    accent:     "#3b78f0",   // 强调蓝（选中 / 滑块 / 进度）
    accent2:    "#2f5fe0",   // 强调蓝渐变末端
    accentText: "#ffffff",
    control:    "#3b78f0",
    warn:       "#e8b25a",
    ok:         "#3ddc84",
    radius:     "10px",      // 卡片圆角
    radiusSm:   "7px",       // 控件圆角
};

const CSS_ID = "qwen21-panel-css";

/** 需要伪类 / 原生控件外观的部分只能走样式表：滑块的轨道与拇指、聚焦环、
 *  悬停态、滚动条。只注入一次，节点被删掉也不影响。 */
function ensurePanelCss() {
    if (document.getElementById(CSS_ID)) return;
    const st = document.createElement("style");
    st.id = CSS_ID;
    st.textContent = `
.q21-range{-webkit-appearance:none;appearance:none;background:transparent;outline:none;cursor:pointer;}
.q21-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;
  background:linear-gradient(90deg,${THEME.accent} 0%,${THEME.accent} var(--q21fill,0%),
  #16294a var(--q21fill,0%),#16294a 100%);}
.q21-range::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:50%;
  background:#fff;border:2px solid ${THEME.accent};margin-top:-4px;
  box-shadow:0 0 0 3px rgba(59,120,240,.22);transition:box-shadow .15s;}
.q21-range:hover::-webkit-slider-thumb{box-shadow:0 0 0 5px rgba(59,120,240,.28);}
.q21-range::-moz-range-track{height:4px;border-radius:2px;background:#16294a;}
.q21-range::-moz-range-progress{height:4px;border-radius:2px;background:${THEME.accent};}
.q21-range::-moz-range-thumb{width:11px;height:11px;border-radius:50%;background:#fff;
  border:2px solid ${THEME.accent};}
.q21 input:focus,.q21 textarea:focus,.q21 select:focus{
  outline:none;border-color:${THEME.accent};box-shadow:0 0 0 2px rgba(59,120,240,.22);}
.q21-mini:hover,.q21-seg:hover:not([data-on="1"]){background:${THEME.hover}!important;
  border-color:#2a4a7d!important;}
.q21-mini:active{transform:translateY(.5px);}
.q21-dark::-webkit-scrollbar{width:7px;height:7px;}
.q21-dark::-webkit-scrollbar-thumb{background:#1d3559;border-radius:4px;}
.q21-dark::-webkit-scrollbar-thumb:hover{background:#2a4a7d;}
.q21-dark::-webkit-scrollbar-track{background:transparent;}
`;
    document.head.appendChild(st);
}

/** 分区标题图标：与参考图一致，每个分区一个彩色小图标（emoji 在 DOM widget 里
 *  渲染最稳，不需要额外资源）。未登记的分区自动不带图标。 */
const SECTION_ICONS = {
    "模式": "👤",
    "参考图": "🏠",
    "保存图像（基本信息）": "🖼",
    "提示词": "✏️",
    "输出尺寸": "📐",
    "采样": "⚙️",
    "加速": "⚡",
    "模型": "🧊",
    "模型（未接线时生效）": "🧊",
    "使用说明": "📄",
};

/* ------------------------------------------------------------------ utils */

function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) n.style.cssText = style;
    if (text != null) n.textContent = text;
    return n;
}

/** 空状态占位：图标 + 一行小字，居中铺在框里（参考图框 / 预览框共用）。 */
function placeholderInto(node, icon, label) {
    node.textContent = "";
    const box = el("div", "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;line-height:1.2;opacity:.85");
    box.append(el("div", "font-size:20px;opacity:.7", icon), el("div", "font-size:10px", label));
    node.append(box);
    return box;
}

/** Keep canvas drag / zoom from hijacking typing, dragging sliders etc. */
function shield(node) {
    for (const ev of ["pointerdown", "mousedown", "wheel", "dblclick"]) {
        node.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    return node;
}

function calcSize(aspect, mp) {
    const map = { "1:1": [1, 1], "3:2": [3, 2], "2:3": [2, 3], "4:3": [4, 3], "3:4": [3, 4], "16:9": [16, 9], "9:16": [9, 16], "21:9": [21, 9] };
    const [wr, hr] = map[aspect] || [1, 1];
    const total = Number(mp) * 1024 * 1024;
    const scale = Math.sqrt(total / (wr * hr));
    return [
        Math.max(32, Math.round((wr * scale) / 32) * 32),
        Math.max(32, Math.round((hr * scale) / 32) * 32),
    ];
}

function section(parent, title, opts) {
    ensurePanelCss();
    const o = opts || {};
    const box = el("div", [
        "box-sizing:border-box",
        `margin:${o.margin || "4px 6px"}`,
        "padding:" + (o.dense ? "7px 9px 8px" : "9px 10px 10px"),
        `border:1px solid ${THEME.cardBorder}`,
        `border-radius:${THEME.radius}`,
        `background:${THEME.cardBg}`,
        // 极轻的内高光：让卡片从底色里浮起一层，接近参考图的层次
        "box-shadow:inset 0 1px 0 rgba(255,255,255,.035)",
        o.flex ? `flex:${o.flex}` : "",
        o.flex ? "min-width:0" : "",
        `font:${FONT}`,
    ].filter(Boolean).join(";"));
    if (title) {
        const head = el("div", "display:flex;align-items:center;gap:6px;margin-bottom:6px;flex:0 0 auto;min-width:0");
        const icon = SECTION_ICONS[title];
        if (icon) {
            head.append(el("span", [
                "flex:0 0 auto", "width:17px", "height:17px", "line-height:17px",
                "text-align:center", "font-size:10px", "border-radius:5px",
                "background:rgba(59,120,240,.16)",
                "border:1px solid rgba(59,120,240,.30)",
            ].join(";"), icon));
        }
        head.append(el("span", [
            "font-weight:600", "font-size:11.5px", `color:${THEME.text}`,
            "letter-spacing:.2px", "white-space:nowrap", "overflow:hidden",
            "text-overflow:ellipsis",
        ].join(";"), title));
        box.append(head);
    }
    parent.append(box);
    return box;
}

function row(parent, label, hint) {
    const wrap = el("div", "display:flex;align-items:center;gap:7px;margin:4px 0");
    const lb = el("span", `flex:0 0 62px;color:${THEME.label};font-size:10.5px`);
    lb.textContent = label;
    wrap.append(lb);
    if (hint) {
        const hp = el("span", "font-size:10px;opacity:.6");
        hp.textContent = hint;
        wrap.append(hp);
    }
    parent.append(wrap);
    return wrap;
}

const INPUT_CSS = [
    "box-sizing:border-box",
    "padding:4px 7px",
    `border-radius:${THEME.radiusSm}`,
    `border:1px solid ${THEME.inputBorder}`,
    `background:${THEME.inputBg}`,
    `color:${THEME.text}`,
    `font:${FONT}`,
    "transition:border-color .15s,box-shadow .15s",
].join(";");

function textarea(parent, value, placeholder, onChange, height) {
    const ta = shield(document.createElement("textarea"));
    ta.value = value ?? "";
    ta.placeholder = placeholder || "";
    ta.style.cssText = [
        "box-sizing:border-box", "width:100%", `min-height:${height || 50}px`,
        "resize:vertical", "padding:6px 8px", `border-radius:${THEME.radiusSm}`,
        `border:1px solid ${THEME.inputBorder}`,
        `background:${THEME.inputBg}`,
        `color:${THEME.text}`, `font:${FONT}`, "line-height:1.55",
        "transition:border-color .15s,box-shadow .15s",
    ].join(";");
    ta.addEventListener("input", () => onChange(ta.value));
    ta.addEventListener("change", () => onChange(ta.value));
    parent.append(ta);
    return ta;
}

function numberBox(value, opts, onChange) {
    const inp = shield(document.createElement("input"));
    inp.type = "number";
    inp.value = value;
    const min = opts.min != null ? Number(opts.min) : null;
    const max = opts.max != null ? Number(opts.max) : null;
    if (min != null) inp.min = opts.min;
    if (max != null) inp.max = opts.max;
    if (opts.step != null) inp.step = opts.step;
    inp.style.cssText = INPUT_CSS + ";flex:0 0 72px";
    /* min / max 只是 HTML 属性，拦不住手输，浏览器只在表单提交时才校验。
     * 越界值一律不写进 state：steps=0 会让采样循环 0 次、不报错直接输出噪点图；
     * megapixels=0 会算出 32×32。所以"输入即校验、失焦才夹"，
     * 既不打断中途输入（"1" → "15"），也不让非法值落地。 */
    const inRange = (n) => (min == null || n >= min) && (max == null || n <= max);
    let last = Number(value);
    inp.addEventListener("input", () => {
        const raw = inp.value.trim();
        if (raw === "" || raw === "-" || raw === "." || raw.endsWith(".")) return;
        const n = Number(raw);
        if (!Number.isFinite(n) || !inRange(n)) return;
        last = n;
        onChange(n);
    });
    // 失焦：空值恢复原值；越界值夹回边界并同步 state，避免"框里是 0、state 也是 0"
    inp.addEventListener("blur", () => {
        const raw = inp.value.trim();
        let n = Number(raw);
        if (raw === "" || !Number.isFinite(n)) n = Number(last);
        if (!Number.isFinite(n)) n = min ?? 0;
        if (min != null) n = Math.max(min, n);
        if (max != null) n = Math.min(max, n);
        inp.value = String(n);
        if (n !== last) {
            last = n;
            onChange(n);
        }
    });
    return inp;
}

/** 滑块左半段染成强调蓝：轨道渐变由 CSS 变量 --q21fill 决定，这里只更新百分比。 */
function paintRangeFill(r) {
    const min = Number(r.min || 0), max = Number(r.max || 100), v = Number(r.value || 0);
    const p = max > min ? ((v - min) / (max - min)) * 100 : 0;
    r.style.setProperty("--q21fill", Math.max(0, Math.min(100, p)).toFixed(1) + "%");
}

function slider(min, max, step, value, onChange) {
    ensurePanelCss();
    const wrap = el("div", "display:flex;align-items:center;gap:7px;flex:1;min-width:0");
    const r = shield(document.createElement("input"));
    r.type = "range";
    r.className = "q21-range";
    r.min = min; r.max = max; r.step = step; r.value = value;
    r.style.cssText = "flex:1;min-width:60px;height:16px";
    paintRangeFill(r);
    const lab = el("span", `flex:0 0 34px;text-align:right;font-variant-numeric:tabular-nums;font-size:10.5px;color:${THEME.text}`);
    lab.textContent = String(value);
    r.addEventListener("input", () => {
        lab.textContent = r.value;
        paintRangeFill(r);
        onChange(Number(r.value));
    });
    wrap.append(r, lab);
    return { wrap };
}

/** 宽屏右列用的滑块：滑块一行，数值单独一行靠右（与参考图一致）。 */
function sliderStacked(min, max, step, value, onChange) {
    ensurePanelCss();
    const wrap = el("div", "display:flex;align-items:center;gap:6px;flex:1;min-width:0");
    const r = shield(document.createElement("input"));
    r.type = "range";
    r.className = "q21-range";
    r.min = min; r.max = max; r.step = step; r.value = value;
    r.style.cssText = "width:100%;height:16px";
    paintRangeFill(r);
    const lab = el("span", `flex:0 0 34px;text-align:right;font-variant-numeric:tabular-nums;font-size:10.5px;color:${THEME.text}`);
    lab.textContent = String(value);
    r.addEventListener("input", () => {
        lab.textContent = r.value;
        paintRangeFill(r);
        onChange(Number(r.value));
    });
    wrap.append(r, lab);
    return { wrap };
}

function select(options, value, onChange, width) {
    const s = shield(document.createElement("select"));
    s.className = "q21-sel";
    s.style.cssText = INPUT_CSS + `;flex:0 0 ${width || 100}px;cursor:pointer`;
    for (const o of options) {
        const opt = document.createElement("option");
        if (Array.isArray(o)) { opt.value = o[0]; opt.textContent = o[1]; }
        else { opt.value = o; opt.textContent = o; }
        s.append(opt);
    }
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    return s;
}

/* ------------------------------------------- 模型列表（从服务端拉真实选项） */

const modelListCache = new Map();

/** 当前打开的目录选择菜单的清理函数（全页面只允许存在一个）。 */
let pathMenuCleanup = null;

/** 读 /object_info 拿某个加载节点的可选文件列表。失败返回空数组，由调用方兜底。 */
async function fetchModelOptions(nodeId, inputName) {
    const key = `${nodeId}.${inputName}`;
    if (modelListCache.has(key)) return modelListCache.get(key);
    let list = [];
    try {
        const res = await fetch(apiUrl(`/object_info/${nodeId}`));
        if (res.ok) {
            const data = await res.json();
            const spec = data?.[nodeId]?.input?.required?.[inputName];
            if (Array.isArray(spec) && Array.isArray(spec[0])) list = spec[0].slice();
        }
    } catch {
        /* 服务端异常时保持原样，不阻断面板 */
    }
    modelListCache.set(key, list);
    return list;
}

/** 把下拉框换成真实模型列表，并保留当前选中值（不在列表里就退回第一项）。 */
async function hydrateModelSelect(sel, nodeId, inputName, current, apply) {
    const list = await fetchModelOptions(nodeId, inputName);
    if (!list.length || !sel.isConnected) return;
    const keep = list.includes(current) ? current : list[0];
    sel.textContent = "";
    for (const name of list) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.append(opt);
    }
    sel.value = keep;
    if (keep !== current) apply(keep);
}

function checkbox(label, value, onChange) {
    const wrap = el("label", "display:flex;align-items:center;gap:5px;cursor:pointer;font-size:10.5px;margin:1px 0");
    const cb = shield(document.createElement("input"));
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.style.cssText = `accent-color:${THEME.control};cursor:pointer;margin:0`;
    cb.addEventListener("change", () => onChange(cb.checked));
    wrap.append(cb, el("span", "", label));
    return { wrap, input: cb };
}

/** 左右滑动开关（替代打勾的 checkbox）。 */
function toggleSwitch(label, value, onChange) {
    ensurePanelCss();
    const wrap = el("label", `display:flex;align-items:center;gap:7px;cursor:pointer;font-size:10.5px;margin:2px 0;color:${THEME.label}`);
    const inp = shield(document.createElement("input"));
    inp.type = "checkbox";
    inp.checked = !!value;
    inp.style.cssText = "position:absolute;opacity:0;width:0;height:0;pointer-events:none";
    const track = el("span", [
        "flex:0 0 auto", "position:relative", "box-sizing:border-box",
        "width:29px", "height:16px", "border-radius:9px", "border:1px solid",
        "transition:background .18s,border-color .18s,box-shadow .18s",
    ].join(";"));
    const knob = el("span", [
        "position:absolute", "top:1.5px", "left:1.5px",
        "width:11px", "height:11px", "border-radius:50%",
        "background:#fff", "box-shadow:0 1px 2px rgba(0,0,0,.45)",
        "transition:transform .18s",
    ].join(";"));
    track.append(knob);
    const txt = el("span", "flex:1 1 auto;min-width:0");
    txt.textContent = label;
    const paint = () => {
        track.style.background = inp.checked
            ? `linear-gradient(180deg,${THEME.accent},${THEME.accent2})`
            : "#0a1830";
        track.style.borderColor = inp.checked ? THEME.accent : THEME.inputBorder;
        track.style.boxShadow = inp.checked ? "0 0 8px rgba(59,120,240,.45)" : "none";
        txt.style.color = inp.checked ? THEME.text : THEME.label;
        knob.style.transform = inp.checked ? "translateX(13px)" : "translateX(0)";
    };
    const set = (v) => { inp.checked = !!v; paint(); };
    inp.addEventListener("change", () => { paint(); onChange(inp.checked); });
    paint();
    wrap.append(inp, track, txt);
    return { wrap, input: inp, set };
}

/* ---- 底部状态栏：告诉用户"现在正在干什么" -------------------------
 * 五态：ready(就绪) / pe(PE 改写中) / gen(生图中，带步数进度) /
 *       done(完成，绿) / fail(失败或回退，黄)。
 * 面板是固定高度，状态栏 flex:0 0 26px 通栏，高度从提示词区扣，总高不变。
 * 颜色全部内联（面板没有样式表），脉冲动画靠注入 <head> 的 @keyframes。
 */
const PULSE_KF_ID = "qwen21-pulse-kf";
function ensurePulseKeyframes() {
    if (document.getElementById(PULSE_KF_ID)) return;
    const st = document.createElement("style");
    st.id = PULSE_KF_ID;
    st.textContent = "@keyframes qwen21pulse{0%,100%{opacity:.25}50%{opacity:1}}";
    document.head.appendChild(st);
}

/** 状态栏悬停提示：解释每个阶段在干什么、大概多久（悬停才看，不占横向空间）。
 *  key 与后端 qwen21_director.py 的 FULL_STAGES 一一对应。 */
const STAGE_HINTS = {
    ref: "把参考图读到内存并缩到目标画布尺寸，通常 1 秒内",
    pe: "PE 是 9B 视觉语言模型，8GB 显存要 offload 到内存，改写一次约 3–7 分钟；跑到 EOS 会提前停，用完自动卸载",
    load: "加载 UNET + CLIP + VAE，首次约 8–12 秒（权重已在内存则跳过）",
    accel: "装配加速链：KV cache 量化 → EasyCache 残差缓存 → torch.compile（可选）",
    encode: "走 Qwen3-VL 8B 文本编码器；cfg ≤ 1 时负向分支跳过，省一次编码",
    latent: "文生图建空 latent；参考图生图直接用编码器产出的 latent",
    sample: "KSampler 迭代去噪，加速档约 8–10 秒，画质档约 100 秒",
    decode: "VAE 解码回像素，分块解码 2–4 秒，整图解码 8–15 秒",
    save: "按文件名前缀落盘到 output 子目录，并写入 PNG 元数据（含提示词与工作流）",
};

function statusBar(parent, getModel) {
    ensurePulseKeyframes();
    const wrap = el("div", [
        "box-sizing:border-box",   // el() 不带全局 border-box，不加会被边框撑高 2px
        "flex:0 0 26px", "margin-top:5px", "display:flex", "align-items:center", "gap:8px",
        "padding:0 10px", `border:1px solid ${THEME.cardBorder}`, "border-radius:8px",
        "background:#04142d", "font-size:10.5px", `color:${THEME.label}`,
        "overflow:hidden", "white-space:nowrap",
    ].join(";"));
    const dot = el("span", `flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:${THEME.muted}`);
    const msg = el("span", "flex:0 1 auto;overflow:hidden;text-overflow:ellipsis");
    // 进度条代表"整次任务"，不是某一阶段的步数 —— 右侧读数与它是同一个数。
    const bar = el("span", [
        "flex:0 0 64px", "height:3px", "border-radius:2px", "overflow:hidden",
        "display:none", "background:#16294a",
    ].join(";"));
    const fill = el("i", `display:block;height:100%;width:0;border-radius:2px;transition:width .3s linear;background:${THEME.accent}`);
    bar.append(fill);
    // 右侧读数：整次任务百分比（原来这里显示模型短名，模型名移到悬停提示里）
    const read = el("span", [
        "margin-left:auto", "flex:0 0 auto", "min-width:30px", "text-align:right",
        "font-size:11px", "font-weight:600", "font-variant-numeric:tabular-nums",
        `color:${THEME.label}`, "user-select:none",
    ].join(";"));
    read.textContent = "0%";
    wrap.append(dot, msg, bar, read);
    parent.append(wrap);

    const api = {
        wrap,
        cur: "ready",   // ready | pe | gen | done | fail
        base: "",       // 阶段文案，由后端 qwen21/stage 事件写入
        step: "",       // 采样步数，由 progress 事件写入
        stage: { key: "", cur: 0, total: 0 },
        modelOverride: "",
        pctBase: 0,     // 进入当前阶段时，整次任务已完成多少（后端按耗时加权算好的）
        pctSpan: 0,     // 当前阶段独占的百分比额度（差值 = 起点到终点）
        sub: 0,         // 当前阶段内的子进度 0–1，采样阶段由步数写入
        secs: 30,       // 当前阶段典型耗时估值：没有子进度信号时按时间爬行
        tStart: 0,      // 当前阶段起点时间戳
        frozen: null,   // 失败时冻结最后一次读数，别回落到 0
        timer: null,
    };

    /** 文案 = [阶段 i/N · ] 阶段说明 [ 步数 ]。
     *  阶段编号来自后端真实分段，前端不猜；后端没推过（比如没重启）就只显示文案。 */
    api.render = () => {
        const s = api.stage;
        const running = api.cur === "pe" || api.cur === "gen";
        // 阶段编号只挂在"正在跑"的状态上；完成/失败是整次运行的结论，不编号。
        const prefix = (running && s.total > 0) ? `阶段 ${s.cur}/${s.total} · ` : "";
        msg.textContent = prefix + api.base + (api.step ? " " + api.step : "");
    };

    /* ---- 整次任务百分比 ------------------------------------------------
     * 两段式：后端按各段典型耗时把流水线加权切成若干百分比区间，每次 qwen21/stage
     * 事件带来当前段的 [pctBase, pctBase+pctSpan]；前端在段内插一个子进度 sub：
     *   采样段：有真实步数 cur/max，直接用，读数最准；
     *   其他段：没有子信号（PE 在后端同步阻塞，前端啥也收不到），就按
     *          "已用时 / 该段典型耗时" 缓慢爬，上限 0.95 —— 永远留一口气给下一跳，
     *          既不会僵在原地让人以为卡死，也不会在真正完成前冲到 100%。
     */
    api.overall = () => {
        const kind = api.cur;
        if (kind === "done") return 100;
        if (kind === "ready") return 0;
        // 失败：冻结在断掉那一刻的读数，别回落成 0（用户还要看跑到哪了）
        if (kind === "fail") return api.frozen == null ? api.pctBase : api.frozen;

        let sub = api.sub > 0 ? api.sub : 0;
        if (sub <= 0) {
            const used = (performance.now() - api.tStart) / 1000;
            sub = Math.min(0.95, used / Math.max(1, api.secs));
        }
        const v = api.pctBase + api.pctSpan * sub;
        return Math.max(0, Math.min(99, v));   // 未完成就绝不显示 100%
    };

    api.renderPct = () => {
        const v = api.overall();
        read.textContent = Math.round(v) + "%";
        fill.style.width = v.toFixed(1) + "%";
        return v;
    };

    /** 只在运行时开表：400ms 一跳，盯着进度条爬行；空闲时立刻停，不留空转。 */
    api.startTick = () => {
        if (api.timer) return;
        api.timer = setInterval(() => api.renderPct(), 400);
    };
    api.stopTick = () => {
        if (api.timer) { clearInterval(api.timer); api.timer = null; }
    };

    /** 配色 / 圆点 / 进度条可见性，只跟 kind 有关。 */
    api.paint = () => {
        const kind = api.cur;
        const running = kind === "pe" || kind === "gen";
        // 运行中圆点用绿色（与 MiniMax 面板一致），不再用紫色 accent
        dot.style.background = kind === "done" ? THEME.ok
            : (kind === "fail") ? THEME.warn
            : running ? "#4fff8f" : THEME.muted;
        dot.style.animation = running ? "qwen21pulse 1.1s ease-in-out infinite" : "none";
        msg.style.color = kind === "done" ? THEME.ok
            : (kind === "fail") ? THEME.warn
            : running ? THEME.text : THEME.label;
        const line = kind === "done" ? THEME.ok
            : (kind === "fail") ? THEME.warn
            : running ? THEME.accent : THEME.inputBorder;
        // 读数：运行中用正文白（参考图里 25% 是浅色字），完成绿、失败黄
        read.style.color = kind === "fail" ? THEME.warn
            : (kind === "done") ? THEME.ok
            : running ? THEME.text : THEME.label;
        fill.style.background = running ? THEME.accent : line;
        // 待命时不画条（读数 0%），跑起来和收尾态都要看得见进度
        bar.style.display = (running || kind === "done" || kind === "fail") ? "" : "none";

        // 右侧读数现在是百分比，模型名收进悬停提示（不再占横向空间）。
        const model = api.modelOverride || (getModel ? String(getModel() || "") : "");
        const tips = [];
        if (model) tips.push(`模型：${model}`);
        const hint = STAGE_HINTS[kind === "pe" ? "pe" : api.stage.key] || "";
        if (hint) tips.push(hint);
        tips.push("右侧读数是整次任务的进度百分比（按各阶段典型耗时加权估算，仅供参考）");
        wrap.title = tips.join("\n");
    };

    /** kind: ready | pe | gen | done | fail */
    api.set = (kind, text) => {
        // 失败前先留住当前读数，下面的清理会把阶段信息清掉
        if (kind === "fail") api.frozen = api.overall();
        api.cur = kind;
        api.base = text || "";
        api.step = "";
        // 任何状态切换都重置爬行起点：不重置的话会拿上一阶段的旧时间戳
        // 算出"已用时远超估值"，读数一下子冲到本段尽头，看着像瞬移。
        api.tStart = performance.now();
        if (kind !== "pe" && kind !== "gen") {
            // 收尾态（完成/失败/就绪）清掉阶段与模型覆盖，下次运行重新计。
            api.stage = { key: "", cur: 0, total: 0 };
            api.modelOverride = "";
            api.pctBase = kind === "done" ? 100 : 0;
            api.pctSpan = 0;
            api.sub = 0;
            if (kind === "ready") api.frozen = null;
        } else {
            // 运行态（pe/gen）也要把区间清零：完成态残留的 pctBase=100 不清的话，
            // 在「完成 → 10 秒内又点运行」这条路径上会带着 100 起跳、被 clamp 成
            // 99%，状态栏一开跑就显示 99%。真正的区间等后端 stage 事件到达再填。
            api.pctBase = 0;
            api.pctSpan = 0;
            api.sub = 0;
            api.frozen = null;
        }
        if (kind === "done") api.pctBase = 100;
        if (kind === "pe" || kind === "gen") {
            api.startTick();
        } else {
            api.stopTick();
            fill.style.width = (kind === "done" ? 100 : api.overall()).toFixed(1) + "%";
        }
        api.render();
        api.paint();
        api.renderPct();
    };

    /** 后端 qwen21/stage 事件：如实播报"现在跑到第几段 / 共几段"，
     *  附带这一段的百分比区间 [pct, pct_end] 与典型耗时 secs。 */
    api.setStage = (data) => {
        if (!data || typeof data !== "object") return;
        const key = String(data.key || "");
        const cur = Number(data.cur) || 0, total = Number(data.total) || 0;
        api.stage = { key, cur, total };
        api.base = String(data.label || "");
        api.step = "";
        api.modelOverride = String(data.model || "");
        // 后端按本次真实 plan 加权算好的区间；老版本后端没这两个字段就退化成等分。
        const pct0 = Number(data.pct), pct1 = Number(data.pct_end);
        if (Number.isFinite(pct0) && Number.isFinite(pct1)) {
            api.pctBase = Math.max(0, Math.min(100, pct0));
            api.pctSpan = Math.max(0, pct1 - api.pctBase);
        } else {
            api.pctBase = total > 0 ? (cur - 1) / total * 100 : 0;
            api.pctSpan = total > 0 ? 100 / total : 0;
        }
        api.secs = Number(data.secs) || 30;
        api.tStart = performance.now();
        api.sub = 0;
        // 只在运行/待命态套用阶段；完成/失败态留给收尾逻辑，别被覆盖。
        if (api.cur === "ready" || api.cur === "pe" || api.cur === "gen") {
            api.cur = key === "pe" ? "pe" : "gen";
        }
        api.startTick();
        api.render();
        api.paint();
        api.renderPct();
    };

    /** 面板换了 UNET 时重新取一次模型名（模型名现在只存在于悬停提示里）。 */
    api.refreshModel = () => {
        api.modelOverride = "";
        api.paint();
    };

    /** 生图进度：cur / max 步。这段是唯一有真实子进度的阶段，直接拿来插百分比。 */
    api.setStep = (cur, max) => {
        if (api.cur !== "gen") return;
        api.step = max > 0 ? `${cur} / ${max} 步` : "";
        api.sub = max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0;
        api.render();
        api.renderPct();
    };
    return api;
}

function buttonGroup(options, value, onPick, btnWidth, opts) {
    // opts.nowrap -> keep every button on one line (segmented control)
    // opts.grow   -> buttons share the available width evenly
    // opts.column -> stack the buttons vertically, each full width
    ensurePanelCss();
    const o = opts || {};
    const wrap = el("div", [
        "display:flex",
        `flex-direction:${o.column ? "column" : "row"}`,
        `flex-wrap:${o.nowrap ? "nowrap" : "wrap"}`,
        "gap:5px",
    ].join(";"));
    const btns = [];
    for (const [v, label] of options) {
        const b = shield(document.createElement("button"));
        b.type = "button";
        b.textContent = label;
        b.dataset.val = v;
        b.className = "q21-seg";
        const css = [
            "padding:5px 8px", "cursor:pointer", `border-radius:${THEME.radiusSm}`,
            `border:1px solid ${THEME.inputBorder}`,
            `background:${THEME.inputBg}`, `color:${THEME.label}`,
            `font:${FONT}`, "transition:background .15s,color .15s,border-color .15s,box-shadow .15s",
            "white-space:nowrap", "text-align:center",
        ];
        if (!o.column && o.grow) {
            css.push("flex:1 1 0", "min-width:0", "padding:5px 4px");
        } else if (!o.column) {
            css.push(`min-width:${btnWidth || 40}px`);
        }
        b.style.cssText = css.join(";");
        b.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            onPick(v);
        });
        btns.push(b);
        wrap.append(b);
    }
    const refresh = (v) => {
        for (const b of btns) {
            const on = b.dataset.val === String(v);
            b.dataset.on = on ? "1" : "";
            // 选中：蓝色渐变 + 轻微外发光，和参考图的"实心蓝按钮"一致
            b.style.background = on
                ? `linear-gradient(180deg,${THEME.accent},${THEME.accent2})`
                : THEME.inputBg;
            b.style.color = on ? THEME.accentText : THEME.label;
            b.style.borderColor = on ? THEME.accent : THEME.inputBorder;
            b.style.fontWeight = on ? "600" : "400";
            b.style.boxShadow = on ? "0 2px 8px rgba(59,120,240,.35)" : "none";
        }
    };
    refresh(value);
    return { wrap, refresh };
}

function miniBtn(text, onClick) {
    ensurePanelCss();
    const b = shield(el("button", [
        "padding:3px 9px", "cursor:pointer", `border-radius:${THEME.radiusSm}`,
        `border:1px solid ${THEME.inputBorder}`,
        `background:${THEME.inputBg}`, `color:${THEME.text}`,
        `font:${FONT}`, "transition:background .15s,border-color .15s",
    ].join(";"), text));
    b.type = "button";
    b.className = "q21-mini";
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
}

/* --------------------------------------------------- optional input ports */

/** Hide optional input dots that carry no link, so the node reads as a panel. */
function syncInputPorts(node, show) {
    if (!node || !Array.isArray(node.inputs) || !node.inputs.length) return 0;
    let touched = 0;

    if (!show) {
        const before = node.inputs.length;
        for (let i = node.inputs.length - 1; i >= 0; i--) {
            const inp = node.inputs[i];
            if (!inp) continue;
            if (!Object.prototype.hasOwnProperty.call(OPTIONAL_INPUTS, inp.name)) continue;
            if (inp.link != null) continue;              // keep wired ports
            try {
                node.removeInput(i);
                touched += 1;
            } catch {
                /* older/newer frontends: fall through silently */
            }
        }
        // Fallback: some frontends expose removeInput but ignore it.
        // Safe to splice directly because every removed port has link == null.
        if (node.inputs.length === before && touched > 0) {
            node.inputs = node.inputs.filter(
                (i) => !(i && Object.prototype.hasOwnProperty.call(OPTIONAL_INPUTS, i.name) && i.link == null),
            );
            touched = before - node.inputs.length;
        }
    } else {
        for (const [name, type] of Object.entries(OPTIONAL_INPUTS)) {
            if (!node.inputs.some((i) => i && i.name === name)) {
                try {
                    node.addInput(name, type);
                    touched += 1;
                } catch {
                    /* ignore */
                }
            }
        }
    }

    if (touched) {
        node.setSize?.([...(node.size || [600, 700])]);
        node.setDirtyCanvas?.(true, true);
        node.graph?.setDirtyCanvas?.(true, true);
    }
    return touched;
}

/** Run the port sync a few times: inputs may be rebuilt after graph restore. */
function scheduleInputPortSync(node, show) {
    for (const ms of [0, 80, 300, 800, 1600]) {
        setTimeout(() => {
            if (!node.graph) return;
            const want = show ?? readShowInputs(node);
            syncInputPorts(node, want);
        }, ms);
    }
}

function readShowInputs(node) {
    try {
        const raw = node.widgets?.find((w) => w && w.name === "panel")?.value;
        return !!JSON.parse(raw || "{}").show_inputs;
    } catch {
        return false;
    }
}

/* ------------------------------------------------------------- panel build */

function buildPanel(node) {
    const pw = node.widgets?.find((w) => w.name === "panel");
    if (!pw) return null;

    let state = {};
    try {
        state = JSON.parse(pw.value || "{}");
    } catch {
        state = {};
    }

    const commit = () => {
        pw.value = JSON.stringify(state);
        if (node.graph) node.graph.setDirtyCanvas(true, true);
        pw.callback?.(pw.value, app.canvas, node);
    };
    const set = (k, v) => { state[k] = v; commit(); };

    // layout:"wide" → 三栏宽屏排版（见 buildWidePanel）。
    // 老工作流没有这个字段，继续走原来的单列布局。
    if (String(state.layout || "") === "wide") {
        return buildWidePanel(node, { state, commit, set });
    }

    ensurePanelCss();
    const root = el("div", [
        "box-sizing:border-box", "width:100%", "padding:8px",
        `border:1px solid ${THEME.cardBorder}`, `border-radius:${THEME.radius}`,
        `background:${THEME.bg}`,
        `font:${FONT}`, `color:${THEME.text}`,
    ].join(";"));
    root.className = "q21 q21-dark";

    /* --- 模式 | 参考图：左右一行，置顶；模式区内两个按钮上下排列 ---- */
    const topRow = el("div", "display:flex;gap:6px;align-items:stretch;margin:4px 6px");

    const modeBox = section(topRow, "模式", { flex: "0 0 44%", margin: "0" });
    modeBox.style.padding = "7px";
    // 参考图区被 92px 预览框撑高，模式区跟着变高；内容垂直居中，别在底部留白。
    modeBox.style.display = "flex";
    modeBox.style.flexDirection = "column";
    const modeBody = el("div", "display:flex;flex-direction:column;justify-content:center;flex:1;min-height:0");
    modeBox.append(modeBody);
    const modeBtns = buttonGroup(
        [["t2i", "文生图"], ["i2i", "参考图"]],
        state.mode || "t2i",
        (v) => { set("mode", v); modeBtns.refresh(v); refreshMode(); },
        0,
        { nowrap: true, column: true },
    );
    modeBody.append(modeBtns.wrap);
    // 用 width 而不是 max-width：纵向 flex 里 auto 外边距会让子项收缩到内容宽度，
    // max-width 只是上限，结果按钮缩成文字宽度。写死 70% 才能既保持宽度又居中。
    modeBtns.wrap.style.width = "70%";
    modeBtns.wrap.style.margin = "0 auto";
    const modeHint = el("div", "margin-top:5px;font-size:10px;opacity:.65;line-height:1.35;text-align:center");
    modeBody.append(modeHint);

    // 参考图卡片：标题收进左列，预览框占满右侧整个高度，
    // 于是上 / 下 / 右 三边间距都等于卡片内距（7px）。
    const refBox = section(topRow, "", { flex: "1 1 auto", margin: "0" });
    refBox.style.padding = "7px";
    refBox.style.display = "flex";
    refBox.style.flexDirection = "column";
    const refRow = el("div", "display:flex;gap:6px;align-items:stretch;flex:1;min-height:0");

    const thumb = el("div", [
        "flex:0 0 100px", "min-height:100px", `border:1px dashed ${THEME.inputBorder}`,
        "border-radius:6px", "display:flex", "align-items:center",
        "justify-content:center", "overflow:hidden",
        "font-size:11px", "opacity:.7", "text-align:center", "padding:3px",
    ].join(";"));
    thumb.textContent = "无图";

    const ctrl = el("div", "display:flex;flex-direction:column;flex:1;min-width:0");
    const refTitle = el("div", "font-weight:600;margin-bottom:6px;font-size:11px;opacity:.9;letter-spacing:.2px");
    refTitle.textContent = "参考图";
    const refName = el("div", "font-size:9.5px;opacity:.8;word-break:break-all;line-height:1.35;margin-bottom:7px");
    const btnRow = el("div", "display:flex;gap:4px;flex-wrap:wrap");

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    shield(fileInput);

    const upBtn = miniBtn("选择图片", () => fileInput.click());
    const clrBtn = miniBtn("清除", () => {
        state.ref_image = "";
        state.ref_subfolder = "";
        commit();
        renderRef();
    });
    clrBtn.style.display = "none";
    btnRow.append(upBtn, clrBtn);
    ctrl.append(refTitle, refName, btnRow);
    // 左：标题、文字与按钮；右：预览框
    refRow.append(ctrl, thumb);
    refBox.append(refRow, fileInput);

    function renderRef() {
        const name = String(state.ref_image || "");
        const sub = String(state.ref_subfolder || "");
        thumb.textContent = "";
        if (!name) {
            thumb.textContent = "无图";
            refName.textContent = "参考图模式在此上传";
            clrBtn.style.display = "none";
            return;
        }
        const img = document.createElement("img");
        img.src = apiUrl(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(sub)}&rand=${Date.now()}`);
        img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;border-radius:3px";
        thumb.append(img);
        refName.textContent = name;
        clrBtn.style.display = "inline-block";
    }

    async function uploadRef(file) {
        const form = new FormData();
        form.append("image", file);
        form.append("type", "input");
        form.append("subfolder", "");
        refName.textContent = "上传中…";
        try {
            const res = await fetch(apiUrl("/upload/image"), { method: "POST", body: form });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data || !data.name) throw new Error("返回中没有文件名");
            state.ref_image = data.name;
            state.ref_subfolder = data.subfolder || "";
            commit();
            renderRef();
        } catch (err) {
            refName.textContent = "上传失败：" + (err?.message || err);
        }
    }

    fileInput.addEventListener("change", () => {
        const f = fileInput.files?.[0];
        if (f) uploadRef(f);
        fileInput.value = "";
    });
    renderRef();

    // 模式 | 参考图 这一行挂到面板根节点（两层 append 缺一不可）。
    root.append(topRow);

    /* --- 提示词（第二位） -------------------------------------------- */
    const pBox = section(root, "提示词", { margin: "0 6px 4px" });
    pBox.append(el("div", "font-size:10px;opacity:.65;margin-bottom:2px", "正向"));
    textarea(pBox, state.prompt, "描述你想要的画面…", (v) => set("prompt", v), 48);
    pBox.append(el("div", "font-size:10px;opacity:.65;margin:5px 0 2px", "负向"));
    textarea(pBox, state.negative, "不想要的元素…", (v) => set("negative", v), 30);
    const cfgWarn = el("div", `margin-top:4px;font-size:9.5px;color:${THEME.warn};display:none`);
    cfgWarn.textContent = "⚠ cfg = 1.0，负向不参与计算（蒸馏模型默认值）";
    pBox.append(cfgWarn);

    /* --- size -------------------------------------------------------- */
    const sBox = section(root, "输出尺寸");
    const aspectBtns = buttonGroup(ASPECTS, state.aspect || "1:1",
        (v) => { set("aspect", v); aspectBtns.refresh(v); refreshSize(); }, 38);
    sBox.append(aspectBtns.wrap);
    const mpRow = row(sBox, "像素量");
    mpRow.append(select(MEGAPIXELS.map((m) => [String(m), `${m} MP`]), String(state.megapixels ?? 1.0),
        (v) => { set("megapixels", Number(v)); refreshSize(); }, 82));
    const sizeLabel = el("div", "margin-top:4px;font-variant-numeric:tabular-nums;font-size:10.5px;opacity:.85");
    sBox.append(sizeLabel);
    const refHint = el("div", `margin-top:3px;font-size:9.5px;color:${THEME.warn};display:none`);
    refHint.textContent = "⚠ 参考图模式：比例请与参考图一致，否则会拉伸";
    sBox.append(refHint);

    /* --- sampler ----------------------------------------------------- */
    const kBox = section(root, "采样");
    const stepsRow = row(kBox, "步数");
    stepsRow.append(numberBox(state.steps ?? 25, { min: 1, max: 200, step: 1 }, (v) => set("steps", v)));
    const cfgRow = row(kBox, "CFG");
    cfgRow.append(slider(0, 8, 0.1, state.cfg ?? 1.0, (v) => { set("cfg", v); refreshCfg(); }).wrap);
    const smRow = row(kBox, "采样器");
    smRow.append(select(["euler", "euler_ancestral", "heun", "dpm_2", "lms", "uni_pc"], state.sampler || "euler", (v) => set("sampler", v), 92));
    const scRow = row(kBox, "调度");
    scRow.append(select(["simple", "normal", "karras", "exponential", "beta"], state.scheduler || "simple", (v) => set("scheduler", v), 92));
    const seedRow = row(kBox, "种子");
    const seedInp = numberBox(state.seed ?? -1, { min: -1, step: 1 }, (v) => set("seed", v));
    seedInp.style.flex = "0 0 104px";
    seedRow.append(seedInp, miniBtn("随机", () => { seedInp.value = "-1"; set("seed", -1); }));
    seedRow.append(el("span", "font-size:9.5px;opacity:.55", "-1 = 每次随机"));

    /* --- acceleration ------------------------------------------------ */
    // 加速状态由各工作流自带：
    //   1、Qwen2.1生图_加速   → easycache=true  → 展开完整控件
    //   2、Qwen2.1生图_不加速 → easycache=false → 收成一行"已关闭"，可一键启用
    const aBox = section(root, "加速");
    const aBody = el("div", "");
    aBox.append(aBody);

    const ecCb = toggleSwitch("EasyCache 缓存加速（省 20~40%）", state.easycache !== false, (v) => { set("easycache", v); refreshAccel(); });
    aBody.append(ecCb.wrap);
    const thRow = row(aBody, "阈值");
    thRow.append(slider(0, 0.6, 0.01, state.easycache_threshold ?? 0.22, (v) => set("easycache_threshold", v)).wrap);
    aBody.append(el("div", "margin:-1px 0 3px 69px;font-size:9.5px;opacity:.55", "0.22 起步；越大越快，细节越易丢"));
    const tcCb = toggleSwitch("TorchCompile 图编译（首次 2~5 分钟，8GB 慎用）", state.torch_compile === true, (v) => set("torch_compile", v));
    aBody.append(tcCb.wrap);
    const kvRow = row(aBody, "KV 缓存");
    const kvSel = select([["int8", "int8（省一半显存）"], ["default", "default（无损）"], ["int4", "int4（误差大）"]], state.kv_dtype || "int8", (v) => { set("kv_dtype", v); refreshAccel(); }, 140);
    kvRow.append(kvSel);
    aBody.append(toggleSwitch("VAE 分块解码（防 OOM）", state.vae_tiled !== false, (v) => set("vae_tiled", v)).wrap);

    const aOff = el("div", "display:none;align-items:center;gap:8px");
    aOff.append(el("span", "font-size:10px;opacity:.7", "本工作流已关闭全部加速（画质优先）"));
    aOff.append(miniBtn("启用加速", () => {
        set("easycache", true);
        set("kv_dtype", "int8");
        ecCb.set(true);
        kvSel.value = "int8";
        refreshAccel();
    }));
    aBox.append(aOff);


    /** 加速是否处于启用状态（任一开关打开即算启用）。 */
    function refreshAccel() {
        const on = state.easycache !== false || state.kv_dtype !== "default" || state.torch_compile === true;
        aBody.style.display = on ? "" : "none";
        aOff.style.display = on ? "none" : "flex";
    }

    /* --- models ------------------------------------------------------ */
    const mBox = section(root, "模型（未接线时生效）");
    const uRow = row(mBox, "UNET");
    const uSel = select([state.unet].filter(Boolean), state.unet, (v) => set("unet", v), 210);
    uRow.append(uSel);
    const cRow = row(mBox, "CLIP");
    const cSel = select([state.clip].filter(Boolean), state.clip, (v) => set("clip", v), 210);
    cRow.append(cSel);
    const vRow = row(mBox, "VAE");
    const vSel = select([state.vae].filter(Boolean), state.vae, (v) => set("vae", v), 210);
    vRow.append(vSel);
    // 选项先按保存值占位，再异步换成服务端的真实模型列表。
    hydrateModelSelect(uSel, "UNETLoader", "unet_name", state.unet ?? "", (v) => set("unet", v));
    hydrateModelSelect(cSel, "CLIPLoader", "clip_name", state.clip ?? "", (v) => set("clip", v));
    hydrateModelSelect(vSel, "VAELoader", "vae_name", state.vae ?? "", (v) => set("vae", v));

    /* --- footer: input ports toggle ---------------------------------- */
    const foot = el("div", "display:flex;align-items:center;gap:6px;margin:6px 6px 2px;font-size:9.5px;opacity:.72");
    const portLabel = el("span", "");
    const portBtn = miniBtn("显示", () => {
        state.show_inputs = !state.show_inputs;
        commit();
        syncInputPorts(node, state.show_inputs);
        refreshPorts();
    });
    foot.append(portLabel, portBtn);
    root.append(foot);

    function refreshPorts() {
        const on = !!state.show_inputs;
        node._qwen21Show = on;          // 供每帧兜底检查使用（避免每帧 JSON.parse）
        portLabel.textContent = on ? "高级输入口：显示中" : "高级输入口：已隐藏";
        portBtn.textContent = on ? "隐藏" : "显示";
    }

    /* --- refreshers --------------------------------------------------- */
    function refreshSize() {
        const [w, h] = calcSize(state.aspect || "1:1", state.megapixels ?? 1.0);
        sizeLabel.textContent = `实际输出：${w} × ${h}`;
    }
    function refreshCfg() {
        cfgWarn.style.display = Number(state.cfg) === 1 && String(state.negative || "").trim()
            ? "block" : "none";
    }
    function refreshMode() {
        const isI2i = state.mode === "i2i";
        modeHint.textContent = isI2i ? "需上传参考图" : "无需参考图";
        refHint.style.display = isI2i ? "block" : "none";
        refBox.style.opacity = isI2i ? "1" : "0.42";
    }

    refreshSize();
    refreshCfg();
    refreshMode();
    refreshPorts();
    refreshAccel();

    shield(root);
    return { root, refreshSize, refreshCfg, refreshMode, refreshPorts };
}

/* ------------------------------------------------- wide layout (三栏宽屏) */

/**
 * 宽屏面板。对应草图：
 *   左侧主区
 *     上半（并排）左 模式 / 参考图，右 保存图像（基本信息）
 *     下半 整块 提示词（正向 + 负向）
 *   右侧参数列（独立一列，纵向贯通整块高度）
 *     高级入口 / 输出尺寸 / 采样 / 加速 / 模型
 * 只改排版，不改任何参数写入逻辑 —— 所有值仍然写回同一个 panel JSON。
 */
function buildWidePanel(node, ctx) {
    const { state, commit, set } = ctx;

    // 面板固定尺寸：内部高度全部按比例分配，不再由内容撑开。
    ensurePanelCss();
    const root = el("div", [
        "box-sizing:border-box", "width:100%",
        `height:${PANEL_WIDE_H - PANEL_OVERHEAD}px`,
        "display:flex", "flex-direction:column", "padding:8px",
        `border:1px solid ${THEME.cardBorder}`, `border-radius:${THEME.radius}`,
        `background:${THEME.bg}`,
        `font:${FONT}`, `color:${THEME.text}`,
    ].join(";"));
    root.className = "q21 q21-dark";

    // 整体：左主区 70% + 右参数列 30%（严格按比例，不再写死像素）
    const shell = el("div", "display:flex;gap:8px;align-items:stretch;flex:1 1 auto;min-height:0");
    const main = el("div", "display:flex;flex-direction:column;gap:8px;flex:70 1 0;min-width:0;min-height:0");
    const colR = el("div", "display:flex;flex-direction:column;gap:8px;flex:30 1 0;min-width:0;min-height:0;overflow:auto");
    shell.append(main, colR);
    root.append(shell);

    // 主区上半：左 模式/参考图（40%）｜ 右 保存图像（60%，正方形预览）
    // 纵向：上半区 30% ｜ 提示词 70%（固定高度下按 flex-grow 精确分配）
    const cols = el("div", "display:flex;gap:8px;align-items:stretch;flex:0 0 auto;min-height:0");
    const colL = el("div", "display:flex;flex-direction:column;gap:8px;flex:40 1 0;min-width:0;min-height:0");
    const colM = el("div", "display:flex;flex-direction:column;gap:8px;flex:60 1 0;min-width:0;min-height:0");
    cols.append(colL, colM);
    main.append(cols);

    /* ============================ 左栏：模式 ============================ */
    const modeBox = section(colL, "模式", { margin: "0" });
    // 草图：模式区约占左栏上四成，参考图区占下六成。
    modeBox.style.flex = "0 0 38%";
    modeBox.style.minHeight = "96px";
    modeBox.style.display = "flex";
    modeBox.style.flexDirection = "column";
    modeBox.style.justifyContent = "center";
    const modeBtns = buttonGroup(
        [["t2i", "文生图"], ["i2i", "参考图"]],
        state.mode || "t2i",
        (v) => { set("mode", v); modeBtns.refresh(v); refreshMode(); },
        0,
        // 参考图里两个模式是并排的段控（一行占满），纵向堆叠会多占一半高度
        { nowrap: true, grow: true },
    );
    modeBtns.wrap.style.width = "100%";
    modeBtns.wrap.style.margin = "0 auto";
    modeBox.append(modeBtns.wrap);
    const modeHint = el("div", "margin-top:5px;font-size:10px;opacity:.65;line-height:1.35;text-align:center");
    modeBox.append(modeHint);

    /* ============================ 左栏：参考图 ========================== */
    const refBox = section(colL, "参考图", { margin: "0" });
    refBox.style.flex = "1 1 auto";
    refBox.style.minHeight = "0";
    refBox.style.display = "flex";
    refBox.style.flexDirection = "column";
    refBox.style.overflow = "hidden";
    const refRow = el("div", "display:flex;gap:7px;align-items:stretch;flex:1 1 auto;min-height:0");
    const refCtrl = el("div", "display:flex;flex-direction:column;flex:0 0 104px;min-width:0;justify-content:flex-start");
    // 这里不再重复一个"选择图片"小标题：外层 section 已经写着"参考图"，下面还有
    // 同名的按钮，三行叠起来会让人分不清哪个能点。
    const refName = el("div", "font-size:9.5px;opacity:.8;word-break:break-all;line-height:1.35;margin-bottom:7px");
    // 按钮推到控制列底部并水平居中
    const btnRow = el("div", "display:flex;flex-direction:column;gap:4px;align-items:center;margin-top:auto;margin-bottom:12px;align-self:center");

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    shield(fileInput);

    const upBtn = miniBtn("选择图片", () => fileInput.click());
    const clrBtn = miniBtn("清除", () => {
        state.ref_image = "";
        state.ref_subfolder = "";
        commit();
        renderRef();
    });
    clrBtn.style.display = "none";
    btnRow.append(upBtn, clrBtn);
    refCtrl.append(refName, btnRow);

    // 图片用绝对定位铺满：不参与 min-content 计算，否则一张大图会把整个左列顶穿。
    const thumb = el("div", [
        "flex:1 1 auto", "min-height:0", "position:relative",
        `border:1px dashed ${THEME.inputBorder}`,
        `border-radius:${THEME.radiusSm}`, "display:flex", "align-items:center",
        "justify-content:center", "overflow:hidden",
        "font-size:11px", "opacity:.7", "text-align:center", "padding:3px",
        `background:${THEME.inputBg}`,
    ].join(";"));
    placeholderInto(thumb, "☁", "无图");
    refRow.append(refCtrl, thumb);
    refBox.append(refRow, fileInput);

    function renderRef() {
        const name = String(state.ref_image || "");
        const sub = String(state.ref_subfolder || "");
        thumb.textContent = "";
        if (!name) {
            placeholderInto(thumb, "☁", "无图");
            refName.textContent = "参考图模式在此上传";
            clrBtn.style.display = "none";
            return;
        }
        const img = document.createElement("img");
        img.src = apiUrl(`/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(sub)}&rand=${Date.now()}`);
        img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;border-radius:3px";
        thumb.append(img);
        refName.textContent = name;
        clrBtn.style.display = "inline-block";
    }

    async function uploadRef(file) {
        const form = new FormData();
        form.append("image", file);
        form.append("type", "input");
        form.append("subfolder", "");
        refName.textContent = "上传中…";
        try {
            const res = await fetch(apiUrl("/upload/image"), { method: "POST", body: form });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data || !data.name) throw new Error("返回中没有文件名");
            state.ref_image = data.name;
            state.ref_subfolder = data.subfolder || "";
            commit();
            renderRef();
        } catch (err) {
            refName.textContent = "上传失败：" + (err?.message || err);
        }
    }

    fileInput.addEventListener("change", () => {
        const f = fileInput.files?.[0];
        if (f) uploadRef(f);
        fileInput.value = "";
    });
    renderRef();

    /* ==================== 主区下半：提示词（整块横跨） ==================== */
    const pBox = section(main, "提示词", { margin: "0" });
    pBox.style.flex = "1 1 auto";
    pBox.style.minHeight = "0";
    pBox.style.display = "flex";
    pBox.style.flexDirection = "column";
    const pWrap = el("div", "display:flex;gap:6px;align-items:stretch;flex:1 1 auto;min-height:0");
    const pCol = el("div", "display:flex;flex-direction:column;flex:1 1 0;min-width:0;min-height:0");
    // 「正向」标签和提示词增强开关挤在同一行，不额外占高度。
    const posHead = el("div", "display:flex;align-items:center;gap:8px;margin-bottom:3px;flex:0 0 auto;min-width:0");
    posHead.append(el("div", "font-size:10px;opacity:.65;flex:0 0 auto", "正向"));
    const peSw = toggleSwitch("提示词增强", state.pe_enabled === true, (v) => { set("pe_enabled", v); node._qwen21Pe = v; paintPe(); });
    node._qwen21Pe = state.pe_enabled === true;   // 供 executing 事件判断是否先跑 PE 阶段
    const peRatioSw = toggleSwitch("采用推荐比例", state.pe_use_ratio === true, (v) => set("pe_use_ratio", v));
    peSw.wrap.style.marginLeft = "auto";   // 两个开关靠右，和「正向」标签分开
    peSw.wrap.style.marginLeft = "auto";   // 两个开关靠右对齐，与「正向」标签分开放
    posHead.append(peSw.wrap, peRatioSw.wrap);
    pCol.append(posHead);
    // 固定高度下不再靠 min-height 撑，正向吃掉剩余高度、负向占 30%。
    const posTa = textarea(pCol, state.prompt, "描述你想要的画面…", (v) => set("prompt", v), 80);
    posTa.style.flex = "1 1 auto";
    posTa.style.minHeight = "70px";
    pCol.append(el("div", "font-size:10px;opacity:.65;margin:8px 0 3px;flex:0 0 auto", "负向"));
    const negTa = textarea(pCol, state.negative, "不想要的元素…", (v) => set("negative", v), 60);
    negTa.style.flex = "0 0 30%";
    negTa.style.minHeight = "60px";
    const cfgWarn = el("div", `margin-top:5px;font-size:9.5px;color:${THEME.warn};display:none`);
    cfgWarn.textContent = "⚠ cfg = 1.0，负向不参与计算（蒸馏模型默认值）";
    pCol.append(cfgWarn);

    /* --- 提示词增强（PE）改写结果预览 -------------------------------- */
    // 后端把改写后的英文长提示词随 ui.pe_result 回传，这里只读展示 + 可复制。
    // 面板高度是固定的，所以预览区限高并可滚动，绝不把提示词框挤没。
    const peBox = el("div", [
        "margin-top:5px", `border:1px solid ${THEME.inputBorder}`, `border-radius:${THEME.radius}`,
        `background:${THEME.inputBg}`, "display:none", "flex:0 0 auto",
        "max-height:58px", "overflow:auto", "padding:4px 6px", "box-sizing:border-box",
    ].join(";"));
    const peNote = el("div", `font-size:9.5px;color:${THEME.accent};font-weight:500;margin-bottom:2px`);
    const peBody = el("div", "font-size:10px;line-height:1.45;white-space:pre-wrap;word-break:break-word;opacity:.9");
    const peCopy = el("span", `font-size:9.5px;color:${THEME.accent};cursor:pointer;text-decoration:underline;margin-left:6px;user-select:none`);
    peCopy.textContent = "复制";
    peCopy.title = "把改写后的提示词复制到剪贴板";
    peCopy.addEventListener("click", () => {
        const t = peResultCache?.prompt || "";
        if (!t) return;
        navigator.clipboard?.writeText(t).then(
            () => { peCopy.textContent = "已复制"; setTimeout(() => { peCopy.textContent = "复制"; }, 1200); },
            () => { peCopy.textContent = "复制失败"; setTimeout(() => { peCopy.textContent = "复制"; }, 1200); },
        );
    });
    peNote.append(peCopy);
    peBox.append(peNote, peBody);
    pCol.append(peBox);

    let peResultCache = null;
    /** 渲染 PE 改写结果。note 为「关闭」或缺失时整块隐藏。 */
    function showPe(pe) {
        peResultCache = pe || null;
        if (!pe || !pe.note || pe.note === "关闭") {
            peBox.style.display = "none";
            return;
        }
        peNote.childNodes[0].textContent = "提示词增强：" + pe.note;
        peBody.textContent = pe.prompt || "（未返回改写文本）";
        peBox.style.display = "block";
        peBox.title = pe.prompt || "";
    }
    /** 「采用推荐比例」只有在增强开着时才有意义，关掉时置灰。 */
    function paintPe() {
        const on = peSw.input.checked;
        peRatioSw.wrap.style.opacity = on ? "1" : ".4";
        peRatioSw.wrap.style.pointerEvents = on ? "" : "none";
    }
    paintPe();
    pWrap.append(pCol);
    pBox.append(pWrap);

    /* ==================== 中栏：保存图像（基本信息） ==================== */
    const saveBox = section(colM, "保存图像（基本信息）", { margin: "0" });
    saveBox.style.flex = "1 1 auto";
    saveBox.style.minHeight = "0";
    saveBox.style.display = "flex";
    saveBox.style.flexDirection = "column";
    // 正文一行：左边信息 + 文件名前缀，右边预览图（贴右，尽量放大）。
    const saveRow = el("div", "display:flex;gap:10px;align-items:stretch;flex:1 1 auto;min-height:0");
    const infoCol = el("div", "display:flex;flex-direction:column;justify-content:flex-start;gap:2px;flex:1 1 auto;min-width:0;min-height:0;padding-bottom:9px;box-sizing:border-box");
    const PREV_INSET = 9;   // 上下留白，与右侧内边距保持一致
    const prevWrap = el("div", [
        "display:flex", "justify-content:flex-end", "align-items:center",
        "flex:0 0 auto", "min-height:0", "overflow:hidden",
        `padding:${PREV_INSET}px 0`,
    ].join(";"));
    const prevBox = el("div", [
        "box-sizing:border-box",
        "flex:0 0 auto", "width:120px", "height:120px",
        `border:1px dashed ${THEME.inputBorder}`,
        `border-radius:${THEME.radiusSm}`, "display:flex", "align-items:center",
        "justify-content:center", "overflow:hidden", `background:${THEME.inputBg}`,
        "font-size:11px", "opacity:.7", "text-align:center", "padding:4px",
    ].join(";"));
    placeholderInto(prevBox, "🖼️", "尚未生成");
    prevWrap.append(prevBox);
    // min-height 预留给「文件/尺寸/加速/耗时」四行：出图前后正方形大小一致，不会跳。
    // margin-top:auto：与下方前缀块分担空白 → 信息块往下沉到中部
    const prevInfo = el("div", "font-size:10px;opacity:.8;line-height:1.7;flex:0 0 auto;min-height:68px;margin-top:auto");
    // 保存参数：原「保存图像」节点的文件名前缀，已并进面板（画布上不再需要那个节点）。
    const prefixRow = el("div", "display:flex;flex-direction:column;gap:3px;margin-top:auto;flex:0 0 auto");
    const prefixLb = el("span", `flex:0 0 auto;color:${THEME.label};font-size:10.5px`);
    prefixLb.textContent = "文件名前缀";
    const prefixInp = el("input", null);
    prefixInp.type = "text";
    prefixInp.style.cssText = INPUT_CSS + ";flex:1 1 auto;min-width:0";
    prefixInp.value = String(state.filename_prefix ?? "Qwen21_Panel");
    prefixInp.title = "支持 %date:yyyy-MM-dd% 等占位符，与内置保存节点一致";
    const applyPrefix = () => {
        const v = String(prefixInp.value || "").trim() || "Qwen21_Panel";
        prefixInp.value = v;
        set("filename_prefix", v);
    };
    prefixInp.addEventListener("change", applyPrefix);
    prefixInp.addEventListener("blur", applyPrefix);
    shield(prefixInp);
    prefixRow.append(prefixLb, prefixInp);

    /* ---- 保存路径：output 下的子目录（留空 = 根目录） ---- */
    const pathBlock = el("div", "display:flex;flex-direction:column;gap:3px;margin-top:6px;flex:0 0 auto");
    const pathLb = el("span", `color:${THEME.label};font-size:10.5px`);
    pathLb.textContent = "保存路径";
    const pathLine = el("div", "display:flex;align-items:center;gap:4px");
    const pathInp = el("input", INPUT_CSS + ";flex:1 1 auto;min-width:0");
    pathInp.type = "text";
    pathInp.placeholder = "输入目录名，留空 = 根目录";
    pathInp.value = String(state.subfolder ?? "");
    pathInp.title = "相对 ComfyUI 的 output 目录，可多级，如 人像/傩戏";
    const cleanPath = (v) => String(v || "").trim().replace(/^\/+|\/+$/g, "");
    const applyPath = () => {
        const v = cleanPath(pathInp.value);
        pathInp.value = v;
        set("subfolder", v);
    };
    pathInp.addEventListener("change", applyPath);
    pathInp.addEventListener("blur", applyPath);
    shield(pathInp);
    const pathBtn = miniBtn("选择", () => openPathPicker());
    pathBtn.style.flex = "0 0 auto";
    pathBtn.style.padding = "2px 8px";
    pathLine.append(pathInp, pathBtn);
    pathBlock.append(pathLb, pathLine);

    /** 弹出 output 下已有子目录的列表（fixed 定位，避免被面板 overflow 裁掉）。 */
    async function openPathPicker() {
        // 上一个菜单还开着：连同它的 document 监听一起收掉，不留堆。
        if (pathMenuCleanup) pathMenuCleanup();
        document.getElementById("qwen21-pathmenu")?.remove();
        let dirs = [];
        let apiOk = false;
        try {
            const res = await fetch(apiUrl("/qwen21/subfolders"));
            if (res.ok) { dirs = (await res.json()).dirs || []; apiOk = true; }
        } catch (e) { /* 接口不可用：仍然允许手输 */ }

        const menu = el("div", [
            "position:fixed", "z-index:100000", "box-sizing:border-box",
            "max-height:220px", "overflow:auto", "padding:3px",
            `background:${THEME.cardBg}`, `border:1px solid ${THEME.cardBorder}`,
            `border-radius:${THEME.radiusSm}`, "box-shadow:0 8px 22px rgba(0,0,0,.5)",
            `font:${FONT}`, `color:${THEME.text}`,
        ].join(";"));
        menu.id = "qwen21-pathmenu";
        const rect = pathInp.getBoundingClientRect();
        menu.style.left = `${Math.round(rect.left)}px`;
        menu.style.top = `${Math.round(rect.bottom + 3)}px`;
        menu.style.width = `${Math.round(Math.max(rect.width, 160))}px`;

        /* 唯一的关闭出口。
         * 原先只有"点菜单外面"这条路会 removeEventListener：点中某一项走的是
         * menu.remove()，document 上那个捕获监听就一直挂着，闭包里还攥着
         * 已移除的 DOM —— 每用一次目录选择器就泄漏一个。 */
        let disposed = false;
        let close = null;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            menu.remove();
            if (close) document.removeEventListener("pointerdown", close, true);
            if (pathMenuCleanup === dispose) pathMenuCleanup = null;
        };

        const item = (label, value) => {
            const it = el("div", "padding:3px 7px;border-radius:4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
            it.textContent = label;
            it.addEventListener("mouseenter", () => { it.style.background = THEME.inputBg; });
            it.addEventListener("mouseleave", () => { it.style.background = "transparent"; });
            it.addEventListener("click", (ev) => {
                ev.stopPropagation();
                pathInp.value = value;
                set("subfolder", value);
                dispose();
            });
            menu.append(it);
        };
        // 顶部提示：告诉用户可以直接输入新目录名（保存时会自动创建）
        const tip = el("div", `padding:2px 7px 4px;font-size:9.5px;opacity:.55;margin-bottom:2px;border-bottom:1px solid ${THEME.cardBorder}`);
        tip.textContent = "可直接输入新目录名，保存时自动创建";
        menu.append(tip);

        item("（output 根目录）", "");
        for (const d of dirs) item(d, d);

        // 输入框里已经有一个不在列表里的名字 → 给一个"就用它"的入口
        const typed = cleanPath(pathInp.value);
        if (typed && !dirs.includes(typed)) item(`＋ 使用「${typed}」`, typed);

        if (!dirs.length) {
            const empty = el("div", "padding:3px 7px;font-size:10px;opacity:.55");
            empty.textContent = apiOk
                ? "output 下还没有子目录 —— 上面框里输入名称即可"
                : "读取目录失败（可能需重启 ComfyUI）—— 仍可手动输入";
            menu.append(empty);
        }
        document.body.append(menu);
        shield(menu);
        pathMenuCleanup = dispose;
        close = (ev) => {
            if (!menu.contains(ev.target)) dispose();
        };
        setTimeout(() => { if (!disposed) document.addEventListener("pointerdown", close, true); }, 0);
    }

    infoCol.append(prevInfo, prefixRow, pathBlock);
    saveRow.append(infoCol, prevWrap);
    saveBox.append(saveRow);

    /** 把正方形锁成 min(可用宽, 可用高)。 */
    function sizeSquare() {
        // 正方形优先吃满行高（上/右/下留白一致），只保证左侧信息至少有 150px。
        const h = saveRow.clientHeight;
        const w = saveRow.clientWidth;
        if (!h || !w) return;
        const side = Math.max(80, Math.min(h - PREV_INSET * 2, w - 150));
        if (Math.abs(prevBox.offsetWidth - side) > 1 || Math.abs(prevBox.offsetHeight - side) > 1) {
            prevBox.style.width = `${side}px`;
            prevBox.style.height = `${side}px`;
        }
    }

    /** 面板高度固定：内容不再撑开节点，root 直接占满 widget 的可用高度。
     *  优先用宿主元素真实高度（自校正标题栏/边距的误差），拿不到时用常量兜底。 */
    function applyHeight() {
        const hostH = node?._qwen21Host?.clientHeight || 0;
        const h = hostH > 200 ? hostH : (PANEL_WIDE_H - PANEL_OVERHEAD);
        if (Math.abs((root.offsetHeight || 0) - h) > 1) root.style.height = `${h}px`;
    }

    function applyRatio() {
        applyHeight();
        // 纵向 30 : 70 —— 用显式高度锁定，避免 flex-grow 在纵轴上的亚像素误差。
        const h = main.clientHeight;
        if (h > 200) {
            const gap = 5;
            const topH = Math.round((h - gap) * 0.3);
            const botH = h - gap - topH;          // 剩下的全给提示词区，两块底边必齐
            if (Math.abs((cols.offsetHeight || 0) - topH) > 1) cols.style.flex = `0 0 ${topH}px`;
            if (Math.abs((pBox.offsetHeight || 0) - botH) > 1) pBox.style.flex = `0 0 ${botH}px`;
        }
        sizeSquare();
    }

    if (typeof ResizeObserver !== "undefined") {
        try { new ResizeObserver(sizeSquare).observe(prevWrap); } catch { /* ignore */ }
        // 用户手动拖高提示词框后，上半区跟着重算，30:70 不会被破坏。
        try { new ResizeObserver(() => applyRatio()).observe(pBox); } catch { /* ignore */ }
    }

    /** 生成完成后由 onExecuted 回填缩略图与运行信息（纯前端，不动后端）。
     *  infoText 来自节点自己返回的 ui.info（尺寸/加速/耗时），
     *  用来顶替原来那个独立的「运行信息」节点。 */
    function showResult(images, infoText, peResult) {
        showPe(peResult);
        const first = (images || [])[0];
        const text = String(infoText || "");
        if (!first || !first.filename) {
            // 保存失败等异常：把后端 info 贴出来，别让面板停在「尚未生成」装没事。
            if (text) {
                prevInfo.innerHTML = "";
                for (const line of text.split("\n")) {
                    const d = el("div", "");
                    d.textContent = line;
                    prevInfo.append(d);
                }
            }
            return;
        }
        prevBox.textContent = "";
        const img = document.createElement("img");
        img.src = apiUrl(`/view?filename=${encodeURIComponent(first.filename)}&type=${encodeURIComponent(first.type || "output")}&subfolder=${encodeURIComponent(first.subfolder || "")}&rand=${Date.now()}`);
        img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;border-radius:3px";
        prevBox.append(img);
        const [w, h] = calcSize(state.aspect || "1:1", state.megapixels ?? 1.0);
        const grab = (re) => { const m = re.exec(text); return m ? m[1].trim() : ""; };
        const lines = [
            `文件：${first.filename}`,
            `尺寸：${w} × ${h}`,
            `加速：${grab(/加速:\s*(.+)/) || (state.easycache !== false ? "EasyCache 已开" : "已关闭")}`,
        ];
        const cost = grab(/耗时:\s*([\d.]+\s*s)/);
        if (cost) lines.push(`耗时：${cost}`);
        prevInfo.innerHTML = "";
        for (const t of lines) {
            const d = el("div", "");
            d.textContent = t;
            prevInfo.append(d);
        }
        prevInfo.title = text;   // 完整运行信息（含种子/解码方式）挂在 tooltip 上
    }

    /* ============================ 右栏：高级入口（已移除） ==============
     * 面板不再提供「显示/隐藏输入口」开关：可选输入口一律按未接线隐藏，
     * 需要外接模型时直接连线（连线后会自动出现）。
     * refreshPorts 保留为空实现，因为 mountPanel / onConfigure 仍会调用它。 */
    function refreshPorts() {
        node._qwen21Show = false;
    }

    /* ============================ 右栏：输出尺寸 ======================== */
    // 右列窄：标签在上、控件整行满宽（与参考截图一致）。
    function fieldRow(parent, label) {
        const wrap = el("div", "display:flex;flex-direction:column;gap:2px;margin:3px 0");
        const lb = el("div", `color:${THEME.label};font-size:10.5px`);
        lb.textContent = label;
        wrap.append(lb);
        parent.append(wrap);
        return wrap;
    }
    function fullSelect(parent, label, options, value, onChange) {
        const wrap = fieldRow(parent, label);
        const s = select(options, value, onChange, 100);
        s.style.flex = "1 1 auto";
        s.style.width = "100%";
        wrap.append(s);
        return s;
    }

    const sBox = section(colR, "输出尺寸", { margin: "0", dense: true });
    fullSelect(sBox, "比例", ASPECTS.map((a) => [a[0], a[0]]), state.aspect || "1:1",
        (v) => { set("aspect", v); refreshSize(); });
    const mpSel = fullSelect(sBox, "像素量", MEGAPIXELS.map((m) => [String(m), `${m} MP`]), String(state.megapixels ?? 1.0),
        (v) => { set("megapixels", Number(v)); refreshSize(); });
    const sizeLabel = el("div", "margin-top:5px;font-variant-numeric:tabular-nums;font-size:10.5px;opacity:.85");
    sBox.append(sizeLabel);
    const refHint = el("div", `margin-top:3px;font-size:9.5px;color:${THEME.warn};display:none`);
    refHint.textContent = "⚠ 参考图模式：比例请与参考图一致，否则会拉伸";
    sBox.append(refHint);

    /* ============================== 右栏：采样 ========================== */
    const kBox = section(colR, "采样", { margin: "0", dense: true });
    const stepsWrap = fieldRow(kBox, "步数");
    const stepsInp = numberBox(state.steps ?? 25, { min: 1, max: 200, step: 1 }, (v) => set("steps", v));
    stepsInp.style.flex = "1 1 auto";
    stepsInp.style.width = "100%";
    stepsWrap.append(stepsInp);
    const cfgWrap = fieldRow(kBox, "CFG");
    cfgWrap.append(sliderStacked(0, 8, 0.1, state.cfg ?? 1.0, (v) => { set("cfg", v); refreshCfg(); }).wrap);
    fullSelect(kBox, "采样器", ["euler", "euler_ancestral", "heun", "dpm_2", "lms", "uni_pc"], state.sampler || "euler",
        (v) => set("sampler", v));
    fullSelect(kBox, "调度", ["simple", "normal", "karras", "exponential", "beta"], state.scheduler || "simple",
        (v) => set("scheduler", v));
    const seedWrap = fieldRow(kBox, "种子");
    // 同一行：左边数值、右边「随机」按钮（省掉一整行高度）
    const seedLine = el("div", "display:flex;align-items:center;gap:6px");
    const seedInp = numberBox(state.seed ?? -1, { min: -1, step: 1 }, (v) => set("seed", v));
    seedInp.style.flex = "1 1 auto";
    seedInp.style.minWidth = "0";
    const randBtn = miniBtn("随机", () => { seedInp.value = "-1"; set("seed", -1); });
    randBtn.style.flex = "0 0 auto";
    randBtn.style.padding = "3px 10px";
    seedLine.append(seedInp, randBtn);
    seedWrap.append(seedLine);

    /* ============================== 右栏：加速 ========================== */
    const aBox = section(colR, "加速", { margin: "0", dense: true });
    const aBody = el("div", "");
    aBox.append(aBody);

    const ecCb = toggleSwitch("EasyCache 缓存加速（省 20~40%）", state.easycache !== false, (v) => { set("easycache", v); refreshAccel(); });
    aBody.append(ecCb.wrap);
    const thWrap = fieldRow(aBody, "阈值");
    thWrap.append(sliderStacked(0, 0.6, 0.01, state.easycache_threshold ?? 0.22, (v) => set("easycache_threshold", v)).wrap);
    const tcCb = toggleSwitch("TorchCompile 图编译（首次 2~5 分钟，8GB 慎用）", state.torch_compile === true, (v) => set("torch_compile", v));
    aBody.append(tcCb.wrap);
    const kvSel = fullSelect(aBody, "KV 缓存", [["int8", "int8（省一半显存）"], ["default", "default（无损）"], ["int4", "int4（误差大）"]], state.kv_dtype || "int8",
        (v) => { set("kv_dtype", v); refreshAccel(); });
    const vaeSw = toggleSwitch("VAE 分块解码（防 OOM）", state.vae_tiled !== false, (v) => set("vae_tiled", v));
    aBody.append(vaeSw.wrap);

    const aOff = el("div", "display:none;align-items:center;gap:8px");
    // 不再重复放一个「启用加速」按钮：右上角那个预设按钮在画质优先时会变成「启用加速」
    aOff.append(el("span", "font-size:10px;opacity:.7", "已关闭全部加速"));
    aBox.append(aOff);

    /* ---- 一键预设：加速 / 画质优先 -------------------------------------
     * 画质优先的配方对齐「2、Qwen2.1生图_不加速」：
     * 关 EasyCache、KV 用 default、VAE 分块保持开、步数 30、像素量 2.25MP。 */
    const PRESET_FAST = { easycache: true, torch_compile: false, kv_dtype: "int8", vae_tiled: true, steps: 25, megapixels: 1.0 };
    const PRESET_QUALITY = { easycache: false, torch_compile: false, kv_dtype: "default", vae_tiled: true, steps: 30, megapixels: 2.25 };

    function currentPreset() {
        if (state.easycache !== false && state.kv_dtype !== "default" && state.torch_compile !== true) return "fast";
        if (state.easycache === false && (state.kv_dtype || "int8") === "default" && state.torch_compile !== true) return "quality";
        return null;   // 手动组合，两个都不选中
    }

    function applyPreset(p) {
        Object.assign(state, p);
        commit();
        ecCb.set(p.easycache);
        tcCb.set(p.torch_compile);
        vaeSw.set(p.vae_tiled);
        kvSel.value = p.kv_dtype;
        stepsInp.value = String(p.steps);
        mpSel.value = String(p.megapixels);
        refreshSize();
        refreshAccel();
    }

    // 只用一个按钮切换：文案写「下一步做什么」
    const presetBtn = miniBtn("画质优先", () => {
        applyPreset(currentPreset() === "quality" ? PRESET_FAST : PRESET_QUALITY);
    });
    presetBtn.style.marginLeft = "auto";
    presetBtn.style.flex = "0 0 auto";
    // 与「随机」按钮同高：同样的字号与内边距
    presetBtn.style.padding = "3px 10px";
    // 塞进标题行，不额外占高度
    const aHead = aBox.firstElementChild;
    if (aHead) {
        aHead.style.display = "flex";
        aHead.style.alignItems = "center";
        aHead.style.gap = "6px";
        aHead.append(presetBtn);
    }

    function refreshAccel() {
        // 画质优先状态下按钮变实心蓝，提示"点它就是重新开加速"
        const inQuality = currentPreset() === "quality";
        presetBtn.textContent = inQuality ? "启用加速" : "画质优先";
        presetBtn.style.background = inQuality
            ? `linear-gradient(180deg,${THEME.accent},${THEME.accent2})`
            : THEME.inputBg;
        presetBtn.style.borderColor = inQuality ? THEME.accent : THEME.inputBorder;
        presetBtn.style.color = inQuality ? THEME.accentText : THEME.text;
        presetBtn.style.fontWeight = inQuality ? "600" : "400";
        presetBtn.style.boxShadow = inQuality ? "0 2px 8px rgba(59,120,240,.35)" : "none";
        const on = state.easycache !== false || state.kv_dtype !== "default" || state.torch_compile === true;
        aBody.style.display = on ? "" : "none";
        aOff.style.display = on ? "none" : "flex";
    }

    /* ============================== 右栏：模型 ========================== */
    const mBox = section(colR, "模型", { margin: "0", dense: true });
    // 右列窄，模型名长：沿用「标签在上、控件整行满宽」的形式。
    // 换 UNET 要同步状态栏悬停提示里的模型名（status 在本函数末尾定义，
    // 但这里的回调只在用户交互时才跑，那时早已初始化完）。
    const setUnet = (v) => { set("unet", v); status?.refreshModel?.(); };
    const uSel = fullSelect(mBox, "UNET", [state.unet].filter(Boolean), state.unet, setUnet);
    const cSel = fullSelect(mBox, "CLIP", [state.clip].filter(Boolean), state.clip, (v) => set("clip", v));
    const vSel = fullSelect(mBox, "VAE", [state.vae].filter(Boolean), state.vae, (v) => set("vae", v));
    hydrateModelSelect(uSel, "UNETLoader", "unet_name", state.unet ?? "", setUnet);
    hydrateModelSelect(cSel, "CLIPLoader", "clip_name", state.clip ?? "", (v) => set("clip", v));
    hydrateModelSelect(vSel, "VAELoader", "vae_name", state.vae ?? "", (v) => set("vae", v));

    /* ============================ 右栏：使用说明 ========================
     * 不再折叠：固定高度下只保留三段最关键的话，全部直接显示。
     * 每段正文压到一行能读完——不写耗时数字（会随硬件和驱动漂移，写进去
     * 反而变成要维护的负担），只说"要不要开、开销在哪、怎么用才生效"。 */
    const helpBox = el("div", [
        "box-sizing:border-box", "margin:0", "padding:4px 7px",
        `border:1px solid ${THEME.cardBorder}`, "border-radius:6px",
        `background:${THEME.cardBg}`, "flex:1 1 auto", "min-height:0", "overflow:hidden",
        `font:${FONT}`,
    ].join(";"));
    const helpList = el("div", "display:flex;flex-direction:column;gap:3px;font-size:10.5px;line-height:1.5");
    [
        // 卸载时机说"改写完立刻"而不是"跑完"：PE 在采样之前就退出，主模型随后才加载。
        ["提示词增强", "改写完立刻卸载权重，不与主模型抢显存；重要出图再开。"],
        // 只陈述数学事实 + 后果，不把"调高 CFG"包装成推荐做法。
        ["负向提示词", "CFG = 1.0 时负向词不参与计算；拉到 2~4 才生效，风格会变。"],
        ["运行前", "先关 Ollama，别让它抢显存。"],
    ].forEach(([k, v]) => {
        const rowH = el("div", "display:flex;gap:4px;align-items:baseline");
        const bt = el("span", `flex:0 0 auto;font-weight:600;opacity:.95;color:${THEME.text}`);
        bt.textContent = k + "：";
        const tx = el("span", `color:${THEME.muted};min-width:0`);
        tx.textContent = v;
        rowH.append(bt, tx);
        helpList.append(rowH);
    });
    const helpTitle = el("div", "font-weight:600;font-size:11.5px;opacity:.92;letter-spacing:.2px;margin-bottom:3px");
    helpTitle.textContent = "使用说明";
    helpBox.append(helpTitle, helpList);
    colR.append(helpBox);

    /* ------------------------------- refreshers ------------------------- */
    function refreshSize() {
        const [w, h] = calcSize(state.aspect || "1:1", state.megapixels ?? 1.0);
        sizeLabel.textContent = `实际输出：${w} × ${h}`;
    }
    function refreshCfg() {
        cfgWarn.style.display = Number(state.cfg) === 1 && String(state.negative || "").trim()
            ? "block" : "none";
    }
    function refreshMode() {
        const isI2i = state.mode === "i2i";
        modeHint.textContent = isI2i ? "需上传参考图" : "无需参考图";
        refHint.style.display = isI2i ? "block" : "none";
        refBox.style.opacity = isI2i ? "1" : "0.42";
    }

    refreshSize();
    refreshCfg();
    refreshMode();
    refreshPorts();
    refreshAccel();
    applyRatio();

    // 底部状态栏：与 shell 同级挂 root，通栏等宽，26px 从提示词区扣。
    const status = statusBar(root, () => state.unet);   // 右侧读数 = 整次任务百分比，模型名在悬停里
    status.set("ready", "就绪 · 等待运行");

    shield(root);
    return { root, refreshSize, refreshCfg, refreshMode, refreshPorts, showResult, showPe, status, layout: applyRatio };
}

/* --- 节点高度：只量"内容"，夹紧，绝不自我膨胀 ---------------------- */

const PANEL_MIN_H = 500;
const PANEL_MAX_H = 2200;      // wide 布局下面板多出一整块提示词，需要更高的上限

/** 让面板宽度跟随节点宽度。
 *  ComfyUI 计算 DOM widget 元素宽度的公式是：元素宽 = widget.width - 2*margin。
 *  把 widget.width 同步成节点宽，元素宽就正好等于节点内宽 —— 内容既不溢出、
 *  也不留白，而且用户拖动节点时内容会跟着重排。
 *  另外把宿主元素也显式写成同样的宽度，双保险（万一是 ComfyUI 改了元素宽度）。
 */
function syncPanelWidth(node) {
    const host = node?._qwen21Host;
    if (!host) return;
    const nodeW = node.size?.[0] || PANEL_NODE_W;
    const widget = node._qwen21Widget;
    if (widget) widget.width = nodeW;
    const px = Math.max(240, nodeW - 20) + "px";
    if (host.style.width !== px) host.style.width = px;
}

/** 从面板内容根元素量高度。
 *  ⚠️ 不能量宿主元素：节点一变高，ComfyUI 会把宿主元素拉高，再量就更大，
 *  节点于是更高 —— 正反馈，见过一次从 720 涨到 2362。 */
function measurePanelHeight(node) {
    // wide 布局是固定尺寸，高度不跟内容走。
    if (node?._qwen21Fixed) return node._qwen21Fixed[1];
    const root = node?._qwen21Panel?.root;
    if (!root) return 0;
    const c = root.scrollHeight || root.offsetHeight || 0;
    if (c < 80) return 0;
    return Math.max(PANEL_MIN_H, Math.min(c + 34, PANEL_MAX_H));
}

/** 只调高度，宽度不动（宽度由用户拖动决定，内容自动跟随）。 */
function fitNodeHeight(node) {
    const h = measurePanelHeight(node);
    if (!h) return;
    const cur = Array.isArray(node.size) ? node.size : [0, 0];
    if (Math.abs((cur[1] || 0) - h) <= 2) return;
    node.setSize([cur[0] || PANEL_NODE_W, h]);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
}

function mountPanel(node) {
    if (node._qwen21Panel?.mounted || typeof node.addDOMWidget !== "function") return;
    const built = buildPanel(node);
    if (!built) return;

    const pw = node.widgets?.find((w) => w.name === "panel");
    if (pw) {
        pw.computeSize = () => [0, -4];
        pw.draw = () => {};
        pw.serialize = true;
        if (pw.element) pw.element.style.display = "none";
    }

    const host = el("div", "box-sizing:border-box;width:100%;padding:0;overflow:hidden");
    const wide = String((() => {
        try { return JSON.parse(pw?.value || "{}").layout || ""; } catch { return ""; }
    })()) === "wide";
    const baseW = wide ? PANEL_WIDE_W : PANEL_NODE_W;
    host.style.width = (baseW - 20) + "px";
    host.append(built.root);
    shield(host);

    if (wide) {
        // 固定尺寸：关掉右下角的缩放手柄，并把节点锁到 PANEL_WIDE_W×PANEL_WIDE_H。
        node._qwen21Fixed = [PANEL_WIDE_W, PANEL_WIDE_H];
        node.resizable = false;
    }

    // 高度只在挂载时定一次，之后不随 draw 更新，避免正反馈。
    // wide 布局是固定高度：直接把 widget 高度写成常量，内容不再撑节点。
    let measured = wide ? PANEL_WIDE_H - PANEL_OVERHEAD : 900;
    const widget = node.addDOMWidget(DOM_WIDGET, "panel_ui", host, {
        getValue: () => "",
        setValue: () => {},
        getMinHeight: () => measured,
        hideOnZoom: false,
        serialize: false,
    });
    widget.serialize = false;
    if (!widget.options) widget.options = {};
    widget.options.serialize = false;

    built.mounted = true;
    built.host = host;
    node._qwen21Panel = built;
    node._qwen21Host = host;
    node._qwen21Widget = widget;
    node._qwen21FitHeight = () => {
        const h = measurePanelHeight(node);
        if (h) measured = h;
        // 固定尺寸：直接把节点锁回去，不走 fitNodeHeight 的内容测量。
        if (node._qwen21Fixed) {
            const [fw, fh] = node._qwen21Fixed;
            const cur = Array.isArray(node.size) ? node.size : [0, 0];
            if (Math.abs(cur[0] - fw) > 0.5 || Math.abs(cur[1] - fh) > 0.5) {
                node.setSize([fw, fh]);
            }
            node.graph?.setDirtyCanvas?.(true, true);
            return;
        }
        fitNodeHeight(node);
    };
    syncPanelWidth(node);

    // Hide unlinked optional ports. Inputs can be rebuilt right after a graph
    // restore, so retry a few times instead of relying on a single pass.
    scheduleInputPortSync(node);
    built.refreshPorts?.();

    // 布局稳定后先定 30:70 与正方形，再量内容高度（多档重试，错过 DOM 重排也能补上）。
    const fit = () => {
        built.layout?.();
        node._qwen21FitHeight?.();
    };
    setTimeout(fit, 0);
    setTimeout(fit, 120);
    setTimeout(fit, 400);
    setTimeout(fit, 900);
}

app.registerExtension({
    name: "ComfyUI.Qwen21Director",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== PANEL_NODE) return;

        // 节点被删除时停掉百分比爬行定时器，并解绑所有 app.api 事件 ——
        // 不解绑的话监听器闭包里攥着 node，删掉的节点永远回收不了；
        // 反复载入工作流还会一路叠加重回调，越用越卡。
        const onRemovedBase = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this._qwen21Panel?.status?.stopTick?.();
            clearTimeout(this._qwen21StatusTimer);
            // 节点被删时目录菜单可能还开着：连带它的 document 监听一起收掉
            if (pathMenuCleanup) pathMenuCleanup();
            for (const [ev, fn] of this._qwen21Listeners || []) {
                try { app.api?.removeEventListener?.(ev, fn); } catch { /* 老版本无此方法 */ }
            }
            this._qwen21Listeners = null;
            return onRemovedBase?.apply(this, arguments);
        };

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated?.apply(this, arguments);
            // 结果图由面板「保存图像」区自己显示，关掉画布上自动生成的输出预览
            // （内置 ImageCompositor / Painter 等自绘节点用的就是这个开关）。
            this.hideOutputImages = true;

            /* ---- 底部状态栏：执行过程驱动（每实例绑定一次）----
             * 主数据源是后端推的 qwen21/stage 自定义事件（后端才知道自己跑到第几段，
             * 尤其 PE 那一段是同步阻塞的，前端只能干等）。
             * executing / progress 只作为兜底：后端没重启、收不到 stage 事件时，
             * 至少状态栏不会一直停在"就绪"。 */
            const node = this;
            const st = () => node._qwen21Panel?.status;
            // 统一登记，onRemoved 里统一解绑（见上面的 onRemoved）
            const on = (ev, fn) => {
                app.api?.addEventListener(ev, fn);
                if (!node._qwen21Listeners) node._qwen21Listeners = [];
                node._qwen21Listeners.push([ev, fn]);
            };

            /* 后端分段播报：{node, key, label, cur, total, model} */
            on("qwen21/stage", (e) => {
                try {
                    const d = e?.detail ?? e;
                    if (!node._qwen21Panel || !d) return;
                    // 广播给所有客户端，这里只认自己这个节点的
                    if (String(d.node ?? "") !== String(node.id)) return;
                    if (!node._qwen21Run) node._qwen21Run = Date.now();
                    clearTimeout(node._qwen21StatusTimer);
                    st()?.setStage(d);
                } catch { /* 状态栏只是展示，绝不影响出图 */ }
            });

            on("executing", (e) => {
                try {
                    // 注意：executing 的 detail 就是节点 id 本身，不是 {node:id} 对象。
                    // （api 打包件：case "executing": dispatchCustomEvent("executing", data.display_node || data.node)）
                    if (!node._qwen21Panel || String(e ?? "") !== String(node.id)) return;
                    clearTimeout(node._qwen21StatusTimer);
                    node._qwen21Run = Date.now();
                    // 后端推过阶段就别覆盖它（编号更准）；没推过才靠开关猜一下。
                    if (!(st()?.stage?.total > 0)) {
                        st()?.set(node._qwen21Pe ? "pe" : "gen",
                            node._qwen21Pe ? "正在改写提示词（PE-9B thinking）…" : "正在生图…");
                    }
                } catch { /* 状态栏只是展示，绝不影响出图 */ }
            });
            /* execution_start 兜底：整个 prompt 开跑。executing 若因故漏拍，
             * 至少不会让 PE 阶段（3–7 分钟）显示在"就绪"上让人以为卡住了。 */
            on("execution_start", () => {
                try {
                    if (!node._qwen21Panel || !node._qwen21Pe) return;   // 只兜 PE 场景
                    const s = st();
                    if (!s || s.cur === "pe" || s.cur === "gen") return;
                    node._qwen21Run = Date.now();
                    s.set("pe", "正在改写提示词（PE-9B thinking）…");
                } catch { /* 同上 */ }
            });
            on("progress", (e) => {
                try {
                    const s = st();
                    if (!s) return;
                    const d = e?.detail ?? e;
                    // progress 是全局广播：工作流里任何一个采样节点都会触发。
                    // 带 node 字段就只认自己的，否则别的节点采样会把本面板的步数冲掉、
                    // 还会把从没运行过的面板标记成"运行中"。
                    const owner = d?.node ?? d?.display_node;
                    if (owner != null && String(owner) !== String(node.id)) return;
                    // _qwen21Run 没置位说明 executing 漏拍了：兜底，别让状态停在"就绪"。
                    if (!node._qwen21Run) node._qwen21Run = Date.now();
                    // 后端没推阶段时，progress 是唯一能证明"在采样"的信号
                    if (!(s.stage?.total > 0) && s.cur !== "gen") s.set("gen", "正在生图…");
                    s.setStep(d?.value ?? 0, d?.max ?? 0);
                } catch { /* 同上 */ }
            });
            on("execution_error", (e) => {
                try {
                    if (!node._qwen21Run) return;
                    // 有 node 字段时只认自己的；没跑过的面板不要跟着报错
                    const d = e?.detail ?? e;
                    const owner = d?.node ?? d?.display_node;
                    if (owner != null && String(owner) !== String(node.id)) return;
                    node._qwen21Run = 0;
                    st()?.set("fail", "⚠ 生图失败，详情看 ComfyUI 控制台");
                } catch { /* 同上 */ }
            });

            setTimeout(() => mountPanel(this), 0);
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this.hideOutputImages = true;   // 载入已有工作流时也要关掉输出预览
            setTimeout(() => {
                if (!this._qwen21Panel) return;
                const { refreshSize, refreshCfg, refreshMode, refreshPorts } = this._qwen21Panel;
                refreshSize?.(); refreshCfg?.(); refreshMode?.(); refreshPorts?.();
                scheduleInputPortSync(this);
                this._qwen21FitHeight?.();
            }, 60);
            return r;
        };

        // 生成完成后把图片回填到中栏的预览区（只读展示，不改任何连线）。
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = onExecuted?.apply(this, arguments);
            try {
                // 后端故意不用 images 这个 key（否则画布上会多画一张输出图）。
                const imgs = message?.panel_images || message?.images;
                const infoText = Array.isArray(message?.info) ? message.info[0] : "";
                // PE 改写结果单独回传：哪怕这次没出图，也要让用户看到改写成了什么。
                this._qwen21Panel?.showPe?.(message?.pe_result || null);
                if ((Array.isArray(imgs) && imgs.length) || infoText) {
                    this._qwen21Panel?.showResult?.(imgs || [], infoText, message?.pe_result || null);
                }
                /* ---- 状态栏：完成 / PE 回退收尾 ---- */
                const sb = this._qwen21Panel?.status;
                if (sb && this._qwen21Run) {
                    const secs = ((Date.now() - this._qwen21Run) / 1000).toFixed(1);
                    const note = message?.pe_result?.note || "";
                    clearTimeout(this._qwen21StatusTimer);
                    this._qwen21Run = 0;
                    if (note.indexOf("失败") >= 0) {
                        sb.set("fail", `⚠ ${note}`);
                    } else if (note.indexOf("已改写") >= 0) {
                        sb.set("done", `✓ 完成 · 用时 ${secs}s · ${note}`);
                    } else {
                        sb.set("done", `✓ 完成 · 用时 ${secs}s`);
                    }
                    // 完成态是临时通知：10 秒后自动回到就绪，不长期占位。
                    this._qwen21StatusTimer = setTimeout(() => {
                        const s2 = this._qwen21Panel?.status;
                        if (s2 && (s2.cur === "done" || s2.cur === "fail")) {
                            s2.set("ready", "就绪 · 等待运行");
                        }
                    }, 10000);
                }
                // 双保险：旧版前端仍可能把结果图塞进 node.imgs 再画到节点背景上。
                this.imgs = null;
                setTimeout(() => {
                    if (this.imgs) { this.imgs = null; this.setDirtyCanvas?.(true, true); }
                }, 0);
            } catch {
                /* 预览回填失败不影响出图 */
            }
            return r;
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const out = onResize?.apply(this, arguments);
            // 宽度跟着节点走：内容既不溢出也不留白，拖动节点时内容同步重排。
            syncPanelWidth(this);
            // 固定尺寸：任何缩放（拖角、菜单、其他扩展）都立刻拉回固定尺寸。
            if (this._qwen21Fixed) {
                const [fw, fh] = this._qwen21Fixed;
                if (Math.abs((size?.[0] ?? 0) - fw) > 0.5 || Math.abs((size?.[1] ?? 0) - fh) > 0.5) {
                    this.setSize([fw, fh]);
                    return out;
                }
                this._qwen21Panel?.layout?.();
                return out;
            }
            // 只有宽度变了才重新量高度（宽度影响换行数）；否则别跟用户的手动拖拽较劲。
            if (Array.isArray(size) && size[0] !== this._qwen21LastW) {
                this._qwen21LastW = size[0];
                this._qwen21Panel?.layout?.();   // 正方形边长随列宽变，须重新取 min(宽,高)
                this._qwen21FitHeight?.();
            }
            return out;
        };

        // 兜底：前端会在加载/重建后把 optional 输入口加回来，而 setTimeout 重试只跑到 1.6s。
        // 这里每帧做一次极廉价的检查（只在真的多出未接线的可选口时才动手），把多余的端口再摘掉。
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            const out = onDrawForeground?.apply(this, arguments);
            if (this._qwen21Panel && !this._qwen21Show && Array.isArray(this.inputs)) {
                for (const inp of this.inputs) {
                    if (!inp || inp.link != null) continue;
                    if (Object.prototype.hasOwnProperty.call(OPTIONAL_INPUTS, inp.name)) {
                        syncInputPorts(this, false);
                        break;
                    }
                }
            }
            return out;
        };
    },
});
