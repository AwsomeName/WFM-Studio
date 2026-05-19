"""DWG → DXF 转换 + 临时文件管理。

两级 fallback 策略：
1. ezdxf ``recover.readfile()``（零外部依赖，支持到 R2018）
2. LibreDWG CLI ``dwg2dxf``（需系统安装，支持较新版本）
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

_log = logging.getLogger(__name__)


class ToolError(RuntimeError):
    """工具调用失败，可展示给用户。"""


def resolve_cad_file(path: Path) -> Path:
    """确保 *path* 是一个可被 ezdxf 读取的文件（.dwg 自动转换）。

    - ``.dxf`` → 原样返回
    - ``.dwg`` → 尝试 ezdxf recover，再 fallback 到 LibreDWG CLI
    - 其它后缀 → 抛 :class:`ToolError`
    """
    if path.suffix.lower() == ".dxf":
        return path
    if path.suffix.lower() == ".dwg":
        try:
            return _dwg_to_dxf_via_ezdxf(path)
        except Exception as exc:
            _log.debug("ezdxf recover 失败 (%s)，尝试 LibreDWG", exc)
        try:
            return _dwg_to_dxf_via_libredwg(path)
        except Exception:
            raise ToolError(
                "无法解析 .dwg 文件。请在 third_party/libredwg/bin/ 下放置对应平台的 "
                "dwg2dxf 二进制，或安装 LibreDWG 到系统 PATH。"
            ) from None
    raise ToolError(f"不支持的文件格式: {path.suffix}")


def _dwg_to_dxf_via_ezdxf(dwg_path: Path) -> Path:
    """ezdxf recover 模式转换 DWG → DXF（零外部依赖）。"""
    import ezdxf  # noqa: PLC0415

    tmp = tempfile.NamedTemporaryFile(
        suffix=".dxf",
        prefix="wfm_cad_ezdxf_",
        delete=False,
    )
    tmp.close()
    try:
        doc, _ = ezdxf.recover.readfile(str(dwg_path))
        doc.saveas(tmp.name)
    except BaseException:
        # 清理失败产物
        try:
            Path(tmp.name).unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return Path(tmp.name)


def _find_dwg2dxf() -> str:
    """查找 dwg2dxf 可执行文件：优先项目内 bundled 二进制，再找系统 PATH。"""
    import sys as _sys  # noqa: PLC0415

    # 1. 项目内 bundled: third_party/libredwg/bin/<platform>/dwg2dxf[.exe]
    if _sys.platform == "win32":
        plat_dir, exe_name = "windows", "dwg2dxf.exe"
    elif _sys.platform == "darwin":
        plat_dir, exe_name = "macos", "dwg2dxf"
    else:
        plat_dir, exe_name = "linux", "dwg2dxf"

    pkg_root = Path(__file__).resolve().parents[2]  # wfm-agents/
    bundled = pkg_root.parent / "third_party" / "libredwg" / "bin" / plat_dir / exe_name
    if bundled.is_file():
        return str(bundled)

    # 2. 系统 PATH
    import shutil  # noqa: PLC0415

    system = shutil.which("dwg2dxf")
    if system:
        return system

    return ""


def _dwg_to_dxf_via_libredwg(dwg_path: Path) -> Path:
    """LibreDWG CLI (dwg2dxf) 转换 DWG → DXF。"""
    cli = _find_dwg2dxf()
    if not cli:
        raise ToolError(
            "dwg2dxf 未找到。请在 third_party/libredwg/bin/ 下放置对应平台的二进制，"
            "或安装 LibreDWG 到系统 PATH。"
        )

    tmp = tempfile.NamedTemporaryFile(
        suffix=".dxf",
        prefix="wfm_cad_libredwg_",
        delete=False,
    )
    tmp.close()
    try:
        subprocess.run(
            [cli, str(dwg_path), "-o", tmp.name],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise ToolError("dwg2dxf 转换超时（60 秒）")
    except subprocess.CalledProcessError as exc:
        raise ToolError(f"dwg2dxf 转换失败: {exc.stderr.strip()}") from exc
    except BaseException:
        try:
            Path(tmp.name).unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return Path(tmp.name)


def save_temp_dxf(dxf_text: str, source_label: str = "viewer") -> Path:
    """将 inline DXF 文本写入临时文件，供 agent 工具读取。"""
    tmp = tempfile.NamedTemporaryFile(
        suffix=".dxf",
        prefix=f"wfm_cad_{source_label}_",
        delete=False,
    )
    tmp.write(dxf_text.encode("utf-8"))
    tmp.close()
    return Path(tmp.name)
