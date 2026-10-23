"""ComfyUI Qwen21 Director — single-node visual panel for Qwen-Image-2.1.

Wraps the whole official Qwen-Image-2.1 pipeline (load -> accelerate -> encode ->
sample -> decode) inside ONE node, driven by a DOM widget panel on the frontend,
so the canvas shows a parameter form instead of a pile of wires.

Apache License 2.0.
"""

from .qwen21_director import Qwen21Director

NODE_CLASS_MAPPINGS = {
    "Qwen21Director": Qwen21Director,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Qwen21Director": "Qwen 2.1 Director（面板）",
}

WEB_DIRECTORY = "./web/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
