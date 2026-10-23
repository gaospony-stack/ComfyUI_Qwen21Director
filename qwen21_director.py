"""Qwen-Image-2.1 Director — one node, one panel, whole pipeline.

The node takes a JSON `panel` blob produced by the frontend panel and executes
the official Qwen-Image-2.1 path internally:

    load (UNET / CLIP / VAE)
      -> TorchCompile (optional)
      -> QwenImage21Cache (KV cache)
      -> EasyCache (optional)
      -> TextEncodeQwenImage21
      -> KSampler
      -> VAEDecode / VAEDecodeTiled

An optional first stage runs the official Qwen-Image-2.1-PE prompt rewriter
(Qwen3.5-VL 9B, int8): it turns a short prompt of any language into a detailed
English prompt plus a recommended aspect ratio, then unloads itself so its
weights never share memory with the UNET + CLIP + VAE trio:

    PE rewrite (optional, self-unloading)
      -> load (UNET / CLIP / VAE) ...
"""

from __future__ import annotations

import json
import math
import os
import time

import nodes

CATEGORY = "Qwen21"

# ---------------------------------------------------------------- 保存路径接口
# 面板上的「保存路径」需要一个可选列表：列出 output 目录下已有的子目录。
try:
    import folder_paths
    from aiohttp import web
    from server import PromptServer

    def _list_subdirs(base: str, depth: int = 3, limit: int = 300):
        """列出 output 下的子目录（含多级，返回相对路径，如 人像/傩戏）。"""
        out = []

        def walk(root: str, prefix: str, level: int):
            if level > depth or len(out) >= limit:
                return
            try:
                names = sorted(os.listdir(root))
            except Exception:
                return
            for name in names:
                if name.startswith(".") or len(out) >= limit:
                    continue
                path = os.path.join(root, name)
                if not os.path.isdir(path):
                    continue
                rel = f"{prefix}{name}"
                out.append(rel)
                walk(path, rel + "/", level + 1)

        walk(base, "", 1)
        return out

    @PromptServer.instance.routes.get("/qwen21/subfolders")
    async def _qwen21_subfolders(request):
        base = folder_paths.get_output_directory()
        return web.json_response({"base": base, "dirs": _list_subdirs(base)})

except Exception:  # 老版本 ComfyUI 没有该接口也不影响出图
    pass

ASPECT_RATIOS = {
    "1:1": (1, 1),
    "2:3": (2, 3),
    "3:2": (3, 2),
    "3:4": (3, 4),
    "4:3": (4, 3),
    "9:16": (9, 16),
    "16:9": (16, 9),
    "21:9": (21, 9),
}

# ---------------------------------------------------------------- 提示词增强 (PE)
# 官方 Qwen-Image-2.1-PE 重写模型（Qwen3.5-VL 9B 微调，Comfy-Org int8 convrot）：
# 把任意语言的短句展开成一段英文长提示词，并给出推荐宽高比。两个权重按模式切换，
# i2i 版额外能吃参考图。它**不**参与 conditioning —— 跑完立刻卸载，
# 所以它的 9.4G 权重不会和后面的 UNET + CLIP + VAE 抢内存。
PE_MODELS = {
    "t2i": "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors",
    "i2i": "qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors",
}
# 官方 README 采样参数：temperature / top_p / top_k 两个模型一致，presence_penalty 不共用
# （T2I 用 1.5 压制自我重复，I2I 用 0）。max_new_tokens 官方给到 16256 / 24000，
# 那是为了兜住极端长输出；实际改写通常在几百 token，这里压到 2048 避免卡死。
PE_SAMPLING = {
    "t2i": {"presence_penalty": 1.5, "max_length": 2048},
    "i2i": {"presence_penalty": 0.0, "max_length": 2048},
}

DEFAULT_PANEL = {
    "mode": "t2i",
    "prompt": ("A cinematic photograph of a woman in her 30s sitting by a paper window in a "
               "modern Chinese courtyard in Yulin, Shaanxi, at dusk. Warm golden light, wooden "
               "furniture, red lanterns, shallow depth of field, realistic, highly detailed."),
    "negative": ("blurry, low quality, distorted face, extra fingers, deformed hands, "
                 "watermark, text, oversaturated"),
    "aspect": "1:1",
    "megapixels": 1.0,
    "steps": 25,
    "cfg": 1.0,
    "sampler": "euler",
    "scheduler": "simple",
    "seed": -1,
    "easycache": True,
    "easycache_threshold": 0.22,
    "torch_compile": False,
    "kv_dtype": "int8",
    "vae_tiled": True,
    "ref_image": "",
    "ref_subfolder": "",
    "filename_prefix": "Qwen21_Panel",
    "subfolder": "",
    "layout": "wide",
    "pe_enabled": False,
    "pe_seed": 0,
    "pe_use_ratio": False,
    "pe_prompt": "",
    "unet": "qwen_image_2.1_int8_convrot.safetensors",
    "clip": "qwen3vl_8b_int8_convrot.safetensors",
    "vae": "qwen_image_2.1_vae_bf16.safetensors",
}

DEFAULT_PANEL_TEXT = json.dumps(DEFAULT_PANEL, ensure_ascii=False, indent=2)


def _calc_size(aspect: str, megapixels: float, multiple: int = 32):
    w_r, h_r = ASPECT_RATIOS.get(aspect, (1, 1))
    total = float(megapixels) * 1024 * 1024
    scale = math.sqrt(total / (w_r * h_r))
    width = max(multiple, round(w_r * scale / multiple) * multiple)
    height = max(multiple, round(h_r * scale / multiple) * multiple)
    return width, height


def _panel_value(raw, key, default):
    """Read a key from the panel blob; fall back to DEFAULT_PANEL then default."""
    if isinstance(raw, dict):
        return raw.get(key, DEFAULT_PANEL.get(key, default))
    return DEFAULT_PANEL.get(key, default)


def _parse_pe_answer(text: str):
    """剥掉  块，从 PE 输出里解析 JSON。

    PE 模型在 think 块之后返回 {"rewritten_prompt": ..., "wh_ratio": "16:9"}
    （i2i 版多一个 ratio_follow）。任何一步失败都返回 (None, 原因)，
    由调用方决定回退，绝不让它把一次生图搞砸。
    """
    _, sep, body = (text or "").partition("</think>")
    if not sep:
        body = text or ""
    body = body.strip()
    if body.startswith("```"):  # 有些采样会把 JSON 裹进代码块
        body = body.split("\n", 1)[-1] if "\n" in body else body
        if body.endswith("```"):
            body = body[:-3]
        body = body.strip()
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end <= start:
        return None, "输出里没有 JSON 对象"
    try:
        data = json.loads(body[start:end + 1])
    except Exception as exc:
        return None, f"JSON 解析失败({exc.__class__.__name__})"
    if not isinstance(data, dict):
        return None, "JSON 不是对象"
    rewritten = str(data.get("rewritten_prompt", "") or "").strip()
    if not rewritten:
        return None, "rewritten_prompt 为空"
    ratio = str(data.get("wh_ratio", "") or "").strip()
    return {"prompt": rewritten, "wh_ratio": ratio}, None


def _release_pe_model(clip):
    """把 PE 模型从显存登记表里摘掉并清显存缓存。

    generate() 内部会调 load_models_gpu([patcher])，把 patcher 注册进
    current_loaded_models；不摘掉的话 9.4G 权重会一直挂着，
    后面主模型加载时内存就双倍了。这里只负责卸载 + 清缓存，
    真正把 RAM 还回去靠调用方断开引用后 gc.collect()。
    """
    if clip is None:
        return
    try:
        import comfy.model_management as mm
        patcher = getattr(clip, "patcher", None)
        if patcher is not None:
            try:
                mm.unload_model_and_clones(patcher, unload_additional_models=False, all_devices=True)
            except Exception:
                # 精确卸载失败才退到全局卸载；此刻主模型还没加载，是安全的。
                mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception:
        pass


# ---------------------------------------------------------------- 阶段播报
# 面板底部状态栏要如实反映"现在跑到哪一步"。前端猜不出来（PE 那一段在
# 后端同步阻塞，前端只会看到一个 executing 事件），所以由后端在每个分段
# 之间主动推一条自定义事件，前端按 node id 过滤后直接显示文案。
STAGE_EVENT = "qwen21/stage"

# 完整流水线。真实运行时会按 mode / pe_enabled 裁掉不适用的几段，
# 编号按裁完之后的序列重新编排，避免出现"阶段 3/9"却从没见过 1、2。
FULL_STAGES = [
    ("ref", "读取参考图"),
    ("pe", "PE 改写提示词"),
    ("load", "加载 UNET / CLIP / VAE"),
    ("accel", "装配加速链"),
    ("encode", "文本编码"),
    ("latent", "准备画布"),
    ("sample", "采样"),
    ("decode", "VAE 解码"),
    ("save", "保存落盘"),
]

# 各段的典型耗时估值（秒），只用来把流水线折算成一个百分比。
# 不能直接拿 "cur/total" 当百分比：PE 那一段 3–7 分钟，读参考图 1 秒，
# 等分会让读数严重失真（卡在 PE 时永远显示 12% 不动，看着像死了）。
# 数值不需要精确到毫秒，只要量级对，读数爬行得比实际慢一点都不会不适。
STAGE_WEIGHT = {
    "ref": 1.0,
    "pe": 240.0,
    "load": 10.0,
    "accel": 4.0,
    "encode": 4.0,
    "latent": 1.0,
    "sample": 30.0,
    "decode": 5.0,
    "save": 2.0,
}


def short_model_tag(name):
    """文件名 → 阶段播报里那段短名：去掉 .safetensors 与 _convrot 后缀。

    只用在阶段文案（"PE 改写提示词 · qwen3.5_9b…"）上。状态栏右侧读数已经
    改成整次任务百分比，模型名只出现在悬停提示里，不再单独约显示。
    """
    text = str(name or "")
    low = text.lower()
    if low.endswith(".safetensors"):
        text = text[:-len(".safetensors")]
        low = text.lower()
    if low.endswith("_convrot"):
        text = text[:-len("_convrot")]
    return text


def _emit_stage(plan, node_id, key, extra="", model=None, weights=None):
    """推送一次阶段变化。plan 形如 [(key, text), ...]，已按当前运行裁剪过。

    weights 与 plan 一一对应（该段的典型耗时估值，秒），用来把"当前第几段"
    折算成整次任务的百分比区间 [pct, pct_end] —— 前端拿这两个数做线性插值：
    采样段有步数子进度就按步数插，其余段没有子信号，就按时间在这个区间里
    慢慢爬，数字不会因为后端同步阻塞而僵住。

    model 用于覆盖状态栏右侧那个"当前模型"标签 —— PE 阶段真正在跑的是
    9B 视觉语言模型，不是 UNET，这时候再显示主模型名就是假的。
    任何异常都吞掉 —— 状态栏只是展示，绝不能因为它把一次出图搞砸。
    """
    try:
        idx = next((i for i, kv in enumerate(plan) if kv[0] == key), -1)
        if idx < 0:
            return
        text = plan[idx][1]
        if extra:
            text = f"{text} · {extra}"
        w = [(weights[i] if weights and i < len(weights) else STAGE_WEIGHT.get(kv[0], 5.0))
             for i, kv in enumerate(plan)]
        w = [max(0.1, float(x)) for x in w]
        total_w = sum(w) or 1.0
        pct = sum(w[:idx]) / total_w * 100.0
        pct_end = sum(w[:idx + 1]) / total_w * 100.0
        from server import PromptServer
        PromptServer.instance.send_sync(STAGE_EVENT, {
            "node": str(node_id),
            "key": key,
            "label": text,
            "cur": idx + 1,
            "total": len(plan),
            "model": str(model or ""),
            "pct": round(pct, 2),        # 进入本段时，整次任务已完成百分之多少
            "pct_end": round(pct_end, 2),  # 本段跑完时能达到多少（两者之差=本段的进度额度）
            "secs": round(w[idx], 1),      # 本段典型耗时：没有子进度信号时靠它爬行
        })
    except Exception:
        pass


class Qwen21Director:
    """Visual-panel Director for Qwen-Image-2.1 (text-to-image / reference-to-image)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "panel": ("STRING", {
                    "multiline": True,
                    "default": DEFAULT_PANEL_TEXT,
                    "tooltip": "Panel state JSON — edited through the node UI, not by hand.",
                }),
            },
            "optional": {
                "model": ("MODEL", {"tooltip": "Optional. Unwired -> loaded from the panel's UNET dropdown."}),
                "clip": ("CLIP", {"tooltip": "Optional. Unwired -> loaded from the panel's CLIP dropdown."}),
                "vae": ("VAE", {"tooltip": "Optional. Unwired -> loaded from the panel's VAE dropdown."}),
                "image": ("IMAGE", {"tooltip": "Reference image. Only used in 参考图生图 mode."}),
            },
            "hidden": {
                "prompt_meta": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                # 阶段播报需要知道"我是哪个节点"，前端才能只更新自己那块状态栏。
                "unique_id": "UNIQUE_ID",
            },
        }

    # 画布上不留输出口：结果直接落盘 + 回填到面板，面板即终点。
    RETURN_TYPES = ()
    FUNCTION = "execute"
    CATEGORY = CATEGORY
    # 本节点自己落盘（等价于内置 SaveImage），所以画布上不再需要保存图像节点。
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Single-node Qwen-Image-2.1 panel: prompts, size, sampler and acceleration "
        "in one form. Wire nothing and it still runs — and it saves the result itself."
    )

    # ------------------------------------------------------------------ #
    def execute(self, panel, model=None, clip=None, vae=None, image=None,
                prompt_meta=None, extra_pnginfo=None, unique_id=None):
        t0 = time.time()

        raw = panel
        if isinstance(raw, str):
            try:
                raw = json.loads(raw) if raw.strip() else {}
            except Exception:
                raw = {}
        if not isinstance(raw, dict):
            raw = {}

        mode = _panel_value(raw, "mode", "t2i")
        pos_prompt = _panel_value(raw, "prompt", "")
        negative = _panel_value(raw, "negative", "")
        aspect = _panel_value(raw, "aspect", "1:1")
        megapixels = float(_panel_value(raw, "megapixels", 1.0))
        steps = int(_panel_value(raw, "steps", 25))
        cfg = float(_panel_value(raw, "cfg", 1.0))
        sampler_name = _panel_value(raw, "sampler", "euler")
        scheduler = _panel_value(raw, "scheduler", "simple")
        seed = int(_panel_value(raw, "seed", -1))
        easycache = bool(_panel_value(raw, "easycache", True))
        cache_threshold = float(_panel_value(raw, "easycache_threshold", 0.22))
        torch_compile = bool(_panel_value(raw, "torch_compile", False))
        kv_dtype = _panel_value(raw, "kv_dtype", "int8")
        vae_tiled = bool(_panel_value(raw, "vae_tiled", True))
        unet_name = _panel_value(raw, "unet", DEFAULT_PANEL["unet"])
        clip_name = _panel_value(raw, "clip", DEFAULT_PANEL["clip"])
        vae_name = _panel_value(raw, "vae", DEFAULT_PANEL["vae"])
        ref_name = str(_panel_value(raw, "ref_image", "") or "").strip()
        ref_sub = str(_panel_value(raw, "ref_subfolder", "") or "").strip()
        prefix = str(_panel_value(raw, "filename_prefix", "") or "").strip() or "Qwen21_Panel"
        sub_dir = str(_panel_value(raw, "subfolder", "") or "").strip().strip("/\\")
        if sub_dir:
            prefix = f"{sub_dir}/{prefix}"

        pe_enabled = bool(_panel_value(raw, "pe_enabled", False))
        pe_use_ratio = bool(_panel_value(raw, "pe_use_ratio", False))
        pe_seed_raw = _panel_value(raw, "pe_seed", 0)
        # 面板回显的改写结果：用户手改过就用他的，没改（空）才用后端刚跑出来的。
        pe_prompt_override = str(_panel_value(raw, "pe_prompt", "") or "").strip()
        pe_note = "关闭"
        pe_result = {"note": pe_note}
        pe_clip = None

        # ---- 0. 阶段播报计划 ---------------------------------------------
        # 按本次真正会跑到的分段裁剪 FULL_STAGES：跳过的段不参与编号，
        # 否则关着 PE 时状态栏会从"阶段 3/9"起跳，而 1、2 压根没出现过。
        plan = [kv for kv in FULL_STAGES if not (
            (kv[0] == "ref" and mode != "i2i")
            or (kv[0] == "pe" and not (pe_enabled and str(pos_prompt).strip()))
        )]
        # 本次 plan 的耗时权重：采样段按实际步数伸缩（步数越多占比越大），
        # 其余段用 STAGE_WEIGHT 的默认值。整体百分比靠它加权，避免等分失真。
        plan_weights = [
            (max(8.0, min(120.0, steps * 1.2)) if kv[0] == "sample"
             else STAGE_WEIGHT.get(kv[0], 5.0))
            for kv in plan
        ]

        def stage(key, extra="", model=None):
            """向面板状态栏播报当前阶段（失败静默，不影响出图）。"""
            _emit_stage(plan, unique_id, key, extra, model, plan_weights)

        # ---- 1. 参考图先加载（i2i；PE 阶段也要看这张图）------------------
        # 放在这里而不是下面的 conditioning 段，是因为 PE 要在主 loader 之前跑，
        # 而 i2i 的 PE 需要参考图内容。缩放仍然等宽高比定下来之后再做。
        stage("ref")
        image_raw = image
        ref_note = "无"
        if mode == "i2i" and image_raw is None:
            if ref_name:
                ref_path = f"{ref_sub}/{ref_name}" if ref_sub else ref_name
                image_raw = nodes.LoadImage().load_image(ref_path)[0]
            else:
                raise ValueError(
                    "参考图生图模式需要一张参考图：在面板「参考图」区点上传，"
                    "或把图片节点接到 image 输入口；不想用参考图就把模式切回「文生图」。"
                )

        # ---- 2. 提示词增强（PE）------------------------------------------
        # 官方推荐的可选前置阶段：短句 → 英文长提示词 + 推荐宽高比。
        # 跑完立刻卸载，峰值内存不会叠加到后面的 UNET + CLIP + VAE 上。
        if pe_enabled and str(pos_prompt).strip():
            import gc
            import random as _random

            pe_key = mode if mode in PE_MODELS else "t2i"
            sampling = PE_SAMPLING.get(pe_key, PE_SAMPLING["t2i"])
            # 让状态栏说明此刻跑的是 PE 权重而不是主模型：9B 视觉语言模型，
            # 显存不够要 offload 到内存，改写耗时随硬件浮动，不说明白容易被当成卡死。
            stage("pe", short_model_tag(PE_MODELS[pe_key]), PE_MODELS[pe_key])
            # 必须先绑定：CLIPLoader 抛异常时 finally 里的 _release_pe_model(pe_clip)
            # 会读到未绑定的局部变量，把「沿用原提示词」的兜底变成 UnboundLocalError。
            pe_clip = None
            try:
                pe_seed = int(pe_seed_raw) if pe_seed_raw is not None else 0
                if pe_seed < 0:
                    pe_seed = _random.randint(0, 0xFFFFFFFF)

                pe_clip = nodes.CLIPLoader().load_clip(PE_MODELS[pe_key], "qwen_image", "default")[0]

                pe_images = []
                if pe_key == "i2i" and image_raw is not None:
                    # PE-I2I 靠参考图理解"在改什么"。缩到 384 级足够它看清内容，
                    # 又不用为一张小图付出全分辨率的视觉编码开销。
                    pe_images = [nodes.ImageScale().upscale(
                        image_raw, "lanczos", 384, 384, "disabled")[0]]

                # Edit 类模型要求图片以 <|image_pad|> 占位符出现在指令里，
                # 否则视觉塔根本不会去看这张图。
                pe_prompt = str(pos_prompt)
                if pe_images:
                    pe_prompt = "Picture 1: <|vision_start|><|image_pad|><|vision_end|>\n" + pe_prompt

                tokens = pe_clip.tokenize(pe_prompt, images=pe_images, thinking=True, min_length=1)
                gen_ids = pe_clip.generate(
                    tokens,
                    do_sample=True,
                    max_length=sampling["max_length"],
                    temperature=1.0,
                    top_k=20,
                    top_p=0.95,
                    min_p=0.0,
                    repetition_penalty=1.0,
                    presence_penalty=sampling["presence_penalty"],
                    seed=pe_seed,
                    mtp=False,
                )
                parsed, why = _parse_pe_answer(pe_clip.decode(gen_ids))
                if parsed:
                    # 用户在面板上手改过改写结果 → 以他为准（pe_prompt_override 优先）
                    if pe_prompt_override:
                        pos_prompt = pe_prompt_override
                        pe_note = f"已改写 · 用手动修改版({len(pe_prompt_override)} 字)"
                    else:
                        pos_prompt = parsed["prompt"]
                        pe_note = f"已改写({len(parsed['prompt'])} 字)"
                        pe_result = {
                            "note": pe_note,
                            "prompt": parsed["prompt"],
                            "wh_ratio": parsed["wh_ratio"],
                        }
                        if pe_use_ratio and parsed["wh_ratio"] in ASPECT_RATIOS:
                            aspect = parsed["wh_ratio"]
                            pe_note += f" · 比例→{aspect}"
                            pe_result["note"] = pe_note
                else:
                    pe_note = f"失败，沿用原提示词（{why}）"
                    pe_result = {"note": pe_note}
            except Exception as exc:
                pe_note = f"失败，沿用原提示词（{exc.__class__.__name__}: {exc}）"
                pe_result = {"note": pe_note}
            finally:
                _release_pe_model(pe_clip)
                pe_clip = None
                gc.collect()
        elif pe_enabled:
            pe_note = "跳过（提示词为空）"

        width, height = _calc_size(aspect, megapixels)

        # ---- 1. loaders -------------------------------------------------
        # 已经在别处（别的节点 / 上一轮）加载好的就不重复报"加载模型"了，
        # 但阶段编号照走，免得用户看到跳号。
        need_load = (model is None) or (clip is None) or (vae is None)
        stage("load", "UNET + CLIP + VAE" if need_load else "复用已加载")
        if model is None:
            model = nodes.UNETLoader().load_unet(unet_name, "default")[0]
        if clip is None:
            clip = nodes.CLIPLoader().load_clip(clip_name, "qwen_image", "default")[0]
        if vae is None:
            vae = nodes.VAELoader().load_vae(vae_name)[0]

        # ---- 2. acceleration chain --------------------------------------
        stage("accel")
        applied = []
        if torch_compile:
            try:
                from comfy_extras.nodes_torch_compile import TorchCompileModel
                model = TorchCompileModel.execute(model, "inductor").result[0]
                applied.append("torch.compile(inductor)")
            except Exception as exc:
                applied.append(f"torch.compile 跳过({exc.__class__.__name__})")

        try:
            from comfy_extras.nodes_qwen import QwenImage21Cache
            model = QwenImage21Cache.execute(model, "auto", kv_dtype).result[0]
            applied.append(f"KV cache={kv_dtype}")
        except Exception as exc:
            applied.append(f"KV cache 跳过({exc.__class__.__name__})")

        if easycache:
            try:
                from comfy_extras.nodes_easycache import EasyCacheNode
                model = EasyCacheNode.execute(
                    model, cache_threshold, 0.15, 0.95, False
                ).result[0]
                applied.append(f"EasyCache({cache_threshold})")
            except Exception as exc:
                applied.append(f"EasyCache 跳过({exc.__class__.__name__})")

        # ---- 3. conditioning --------------------------------------------
        stage("encode", f"{width}x{height}")
        from comfy_extras.nodes_qwen import TextEncodeQwenImage21

        images = None
        resolution = 1024

        if mode == "i2i":
            # Scale the reference to the requested canvas so latent and output agree.
            # 图片本体在上面第 1 步就加载好了（PE 也要用），这里只做缩放。
            image_ready = nodes.ImageScale().upscale(
                image_raw, "lanczos", width, height, "disabled")[0]
            images = {"image_1": image_ready}
            resolution = 0
            ref_note = f"{ref_name or '外部接线'} → {width}x{height}"

        # With cfg <= 1.0 the negative branch is mathematically dead:
        # out = uncond + cfg * (cond - uncond). The official node still spends a
        # second pass through the 8B text encoder on it, so feed it an empty
        # string and save that pass. The result is unused anyway.
        negative_for_encode = negative if cfg > 1.0 else ""

        encoded = TextEncodeQwenImage21.execute(
            clip=clip,
            prompt=pos_prompt,
            negative_prompt=negative_for_encode,
            vae=vae if mode == "i2i" else None,
            resolution=resolution,
            images=images,
        )
        positive, negative_cond, te_latent = encoded.result

        # ---- 4. latent ---------------------------------------------------
        stage("latent")
        if mode == "i2i":
            latent_image = te_latent
        else:
            latent_image = nodes.EmptyLatentImage().generate(width, height, 1)[0]

        # ---- 5. sample ---------------------------------------------------
        if seed is None or seed < 0:
            import random
            seed = random.randint(0, 0xFFFFFFFFFFFFFFFF)
            used_seed_note = f"{seed}（随机）"
        else:
            used_seed_note = str(seed)

        # 步数进度由前端的 progress 事件补（"12 / 30 步"），这里别再写一遍。
        stage("sample")
        samples = nodes.KSampler().sample(
            model, seed, steps, cfg, sampler_name, scheduler,
            positive, negative_cond, latent_image, 1.0,
        )[0]

        # ---- 6. decode ---------------------------------------------------
        stage("decode", "分块" if vae_tiled else "整图")
        if vae_tiled:
            image_out = nodes.VAEDecodeTiled().decode(vae, samples, 512, 64, 64, 8)[0]
            decode_note = "分块解码"
        else:
            image_out = nodes.VAEDecode().decode(vae, samples)[0]
            decode_note = "整图解码"

        elapsed = time.time() - t0
        info = (
            f"模式: {'参考图生图' if mode == 'i2i' else '文生图'}\n"
            f"尺寸: {width} x {height}  ({aspect} @ {megapixels} MP)\n"
            f"采样: steps={steps}, cfg={cfg}, {sampler_name}/{scheduler}\n"
            f"种子: {used_seed_note}\n"
            f"参考图: {ref_note}\n"
            f"提示词增强: {pe_note}\n"
            f"解码: {decode_note}\n"
            f"加速: {', '.join(applied) if applied else '无'}\n"
            f"耗时: {elapsed:.1f}s"
        )
        if cfg == 1.0 and negative.strip():
            info += "\n⚠ cfg=1.0：负向提示词未参与计算（蒸馏模型默认值）"

        # ---- 7. save -----------------------------------------------------
        # 复用内置 SaveImage 的落盘逻辑：文件名规则、%date% 等占位符、子目录、
        # PNG 元数据（内嵌 prompt / workflow，可回溯）都与拖一个「保存图像」节点一致。
        stage("save")
        saved_images = []
        try:
            saved = nodes.SaveImage().save_images(image_out, prefix, prompt_meta, extra_pnginfo)
            saved_images = (saved or {}).get("ui", {}).get("images", []) or []
            if saved_images:
                info += f"\n文件: {saved_images[0]['filename']}"
        except Exception as exc:  # 保存失败不该让整次出图白跑
            info += f"\n⚠ 保存失败: {exc.__class__.__name__}: {exc}"

        return {
            # 关键：这里**不能**叫 images。
            # 前端只要在 ui 里看到 images 字段，就会在节点下方再画一张输出预览图
            # （hideOutputImages 只挡得住其中一条渲染路径，挡不干净）。
            # 用自定义 key，面板自己取来显示，画布上就不会多出那张图。
            "ui": {"panel_images": saved_images, "info": [info], "pe_result": pe_result},
        }
