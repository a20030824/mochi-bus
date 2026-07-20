from pathlib import Path

path = Path('src/lib/tdx.ts')
text = path.read_text(encoding='utf-8')
old = """  const body = await readTextResponse(response, TDX_ERROR_MAX_RESPONSE_BYTES, true).catch(() => ({\n"""
new = """  const body: TDXBoundedTextResponse = await readTextResponse(\n    response,\n    TDX_ERROR_MAX_RESPONSE_BYTES,\n    true,\n  ).catch((): TDXBoundedTextResponse => ({\n"""
if text.count(old) != 1:
    raise RuntimeError(f'bounded error body type anchor count: {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
