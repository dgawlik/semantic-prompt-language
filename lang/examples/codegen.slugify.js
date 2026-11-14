// @CODEGEN sha256:e9c00abc03c582fbbd8d889065b20a968a2b775dad6aed327170d1f427778f04
function slugify(title) {
    const lower = title.toLowerCase().trim();
    const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug;
}
