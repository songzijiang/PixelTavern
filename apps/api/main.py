from __future__ import annotations

import logging
import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from config import setup_logging, DATA_DIR

setup_logging()
logger = logging.getLogger(__name__)

app = FastAPI(title="PixelTavern")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

from routers.world import router as world_router
from routers.records import router as records_router
from routers.characters import router as characters_router
from routers.settings import router as settings_router
from services import world_store

# 初始化数据库
world_store.init_db()
# 迁移旧格式数据（world_events → cycle_messages）
world_store.migrate_old_events_to_cycle_messages()

app.include_router(world_router)
app.include_router(records_router)
app.include_router(characters_router)
app.include_router(settings_router)


@app.post("/api/admin/clear")
async def clear_all_data():
    """清空所有世界事件和周期消息数据。"""
    from services.world_store import clear_all
    clear_all()
    logger.warning("所有数据已清空")
    return {"ok": True, "message": "所有 world_events 和 cycle_messages 已清空"}


_DISCLAIMER_FILE = os.path.join(DATA_DIR, ".disclaimer_accepted")


@app.get("/api/admin/first-run")
async def check_first_run():
    """检查是否为首次运行（免责声明未接受）。"""
    return {"firstRun": not os.path.isfile(_DISCLAIMER_FILE)}


@app.post("/api/admin/disclaimer-accept")
async def accept_disclaimer():
    """接受免责声明，创建标记文件。"""
    try:
        os.makedirs(os.path.dirname(_DISCLAIMER_FILE), exist_ok=True)
        with open(_DISCLAIMER_FILE, "w", encoding="utf-8") as f:
            f.write("accepted")
        logger.info("免责声明已接受")
        return {"ok": True}
    except Exception as e:
        logger.error("写入免责声明标记文件失败: %s", e)
        return {"ok": False, "error": str(e)}


# 静态文件服务（生产模式）
def _static_dir() -> str | None:
    """返回前端构建目录的路径，开发模式返回 None。"""
    if getattr(sys, "frozen", False):
        base = sys._MEIPASS
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    for candidate in (
        os.path.join(base, "web", "dist"),
        os.path.join(os.path.dirname(base), "web", "dist"),
        os.path.join(os.path.dirname(base), "apps", "web", "dist"),
        os.path.join(base, "dist"),
    ):
        if os.path.isdir(candidate):
            return candidate
    return None


_static = _static_dir()
if _static:
    logger.info("静态文件目录: %s", _static)
    app.mount("/assets", StaticFiles(directory=os.path.join(_static, "assets")), name="assets")

    @app.get("/")
    async def _serve_index():
        return FileResponse(
            os.path.join(_static, "index.html"),
            media_type="text/html; charset=utf-8",
        )

    @app.exception_handler(404)
    async def _spa_fallback(request, exc):
        if request.url.path.startswith("/api/"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        return FileResponse(
            os.path.join(_static, "index.html"),
            media_type="text/html; charset=utf-8",
        )
else:
    logger.info("未找到前端构建目录，仅 API 模式运行")


if __name__ == "__main__":
    import uvicorn
    import threading
    import webbrowser

    from config import get_server_host, get_server_port
    host = get_server_host()
    port = int(os.environ.get("PORT", str(get_server_port())))

    # 打包模式：启动后自动打开浏览器
    if getattr(sys, "frozen", False):
        def _open_browser():
            import time
            time.sleep(2)
            webbrowser.open(f"http://localhost:{port}")

        threading.Thread(target=_open_browser, daemon=True).start()

    uvicorn.run(app, host=host, port=port, reload=False, access_log=False)
