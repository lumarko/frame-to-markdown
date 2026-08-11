"use strict";
figma.showUI(__html__, { width: 520, height: 600 });

// --- Utilities ---

function rgbToHex(r, g, b) {
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbaToString(r, g, b, a) {
  if (a >= 1) return rgbToHex(r, g, b);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${parseFloat(a.toFixed(2))})`;
}

function roundValue(val) {
  const rounded = Math.round(val * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 0.01) return Math.round(rounded);
  return rounded;
}

function formatNodeType(type) {
  if (!type) return "Unknown";
  return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
}

// --- Unit conversion ---

let UNIT = "px";
let ROOT_SIZE = { width: 1440, height: 900 };

function px(value) {
  if (value === 0) return "0";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return `${value}`;

  switch (UNIT) {
    case "rem":
      return `${roundValue(num / 16)}rem`;
    case "em":
      return `${roundValue(num / 16)}em`;
    case "vw":
      return `${roundValue((num / ROOT_SIZE.width) * 100)}vw`;
    case "vh":
      return `${roundValue((num / ROOT_SIZE.height) * 100)}vh`;
    default:
      return `${num}px`;
  }
}

// --- Variable & Style resolution ---

const variableCache = new Map();
const styleCache = new Map();

async function resolveVariableById(id) {
  if (variableCache.has(id)) return variableCache.get(id);
  try {
    const variable = await withTimeout(figma.variables.getVariableByIdAsync(id), 2000);
    if (variable) {
      const cssName = "--" + variable.name.replace(/\//g, "-").replace(/\s+/g, "-").toLowerCase();
      const result = { name: cssName, variable };
      variableCache.set(id, result);
      return result;
    }
  } catch (e) {}
  return null;
}

async function resolveStyleById(id) {
  if (!id || id === "") return null;
  if (styleCache.has(id)) return styleCache.get(id);
  try {
    const style = await withTimeout(figma.getStyleByIdAsync(id), 2000);
    if (style) {
      const cssName = "--" + style.name.replace(/\//g, "-").replace(/\s+/g, "-").toLowerCase();
      const result = { name: cssName, style };
      styleCache.set(id, result);
      return result;
    }
  } catch (e) {}
  return null;
}

async function resolveColorVariable(variableAlias, fallbackValue) {
  if (!variableAlias || !variableAlias.id) return fallbackValue;
  const resolved = await resolveVariableById(variableAlias.id);
  if (resolved) return `var(${resolved.name}, ${fallbackValue})`;
  return fallbackValue;
}

async function resolveNumericVariable(variableAlias, pxValue) {
  if (!variableAlias || !variableAlias.id) return px(pxValue);
  const resolved = await resolveVariableById(variableAlias.id);
  if (resolved) return `var(${resolved.name}, ${px(pxValue)})`;
  return px(pxValue);
}

function getBoundVariable(node, property) {
  if (!node.boundVariables) return null;
  const binding = node.boundVariables[property];
  if (!binding) return null;
  if (Array.isArray(binding)) return binding.length > 0 ? binding[0] : null;
  return binding;
}

function getBoundFillVariable(node, index) {
  if (!node.boundVariables) return null;
  const fills = node.boundVariables.fills;
  if (!fills || !Array.isArray(fills)) return null;
  return fills[index] || null;
}

// --- Fill/Color extraction ---

function getGradientAngle(fill) {
  if (!fill.gradientTransform) return 180;
  const [[a], [c]] = fill.gradientTransform;
  const angle = Math.round(Math.atan2(c, a) * (180 / Math.PI) + 90);
  return angle < 0 ? angle + 360 : angle;
}

function getFillRawValue(fill) {
  if (fill.type === "SOLID") {
    const a = fill.opacity !== undefined ? fill.opacity : 1;
    return rgbaToString(fill.color.r, fill.color.g, fill.color.b, a);
  }
  if (fill.type === "GRADIENT_LINEAR") {
    const angle = getGradientAngle(fill);
    const stops = fill.gradientStops.map((s) => {
      const c = rgbaToString(s.color.r, s.color.g, s.color.b, s.color.a);
      return `${c} ${Math.round(s.position * 100)}%`;
    }).join(", ");
    return `linear-gradient(${angle}deg, ${stops})`;
  }
  if (fill.type === "GRADIENT_RADIAL") {
    const stops = fill.gradientStops.map((s) => {
      const c = rgbaToString(s.color.r, s.color.g, s.color.b, s.color.a);
      return `${c} ${Math.round(s.position * 100)}%`;
    }).join(", ");
    return `radial-gradient(${stops})`;
  }
  if (fill.type === "GRADIENT_ANGULAR") {
    const stops = fill.gradientStops.map((s) => {
      const c = rgbaToString(s.color.r, s.color.g, s.color.b, s.color.a);
      return `${c} ${Math.round(s.position * 100)}%`;
    }).join(", ");
    return `conic-gradient(${stops})`;
  }
  return null;
}

async function extractFillWithContext(node) {
  if (!("fills" in node)) return null;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return null;

  let propName = "background";
  if (node.type === "TEXT") propName = "color";
  else if (["VECTOR", "BOOLEAN_OPERATION", "LINE", "STAR", "POLYGON"].includes(node.type)) propName = "fill";

  const fillStyleId = "fillStyleId" in node ? node.fillStyleId : null;
  const hasStyle = fillStyleId && fillStyleId !== "" && fillStyleId !== figma.mixed;

  const results = [];

  for (let i = 0; i < fills.length; i++) {
    const fill = fills[i];
    if (fill.visible === false) continue;
    if (fill.type === "IMAGE" || fill.type === "VIDEO") continue;

    const rawValue = getFillRawValue(fill);
    if (!rawValue) continue;

    const boundVar = getBoundFillVariable(node, i);
    if (boundVar) {
      results.push(await resolveColorVariable(boundVar, rawValue));
      continue;
    }

    if (hasStyle && i === 0) {
      const resolvedStyle = await resolveStyleById(fillStyleId);
      if (resolvedStyle) {
        results.push(`var(${resolvedStyle.name}, ${rawValue})`);
        continue;
      }
    }

    results.push(rawValue);
  }

  if (results.length === 0) return null;
  const value = results.length === 1 ? results[0] : results.join(", ");
  return { property: propName, value };
}

function getImageFillInfo(node) {
  if (!("fills" in node)) return null;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return null;
  for (const fill of fills) {
    if (fill.visible === false) continue;
    if (fill.type === "IMAGE") {
      const scaleMap = { FILL: "cover", FIT: "contain", CROP: "cover (cropped)", TILE: "repeat" };
      return { type: "image", scaleMode: scaleMap[fill.scaleMode] || fill.scaleMode };
    }
    if (fill.type === "VIDEO") {
      return { type: "video", scaleMode: fill.scaleMode || "cover" };
    }
  }
  return null;
}

// --- SVG ---

function isSvgExportable(node) {
  return ["VECTOR", "BOOLEAN_OPERATION", "LINE", "STAR", "POLYGON"].includes(node.type);
}

async function exportSvgString(node) {
  try {
    const svgBytes = await withTimeout(node.exportAsync({ format: "SVG" }), 3000);
    const svgString = String.fromCharCode.apply(null, new Uint8Array(svgBytes));
    return svgString.replace(/<\?xml[^?]*\?>\s*/g, "").replace(/<!--.*?-->\s*/g, "").trim();
  } catch (e) {
    return null;
  }
}

// --- Stroke ---

async function extractStroke(node) {
  if (!("strokes" in node)) return [];
  const strokes = node.strokes;
  if (!Array.isArray(strokes) || strokes.length === 0) return [];

  const props = [];
  const visible = strokes.find((s) => s.visible !== false);
  if (!visible) return [];

  if (visible.type === "SOLID") {
    const hex = rgbToHex(visible.color.r, visible.color.g, visible.color.b);
    const a = visible.opacity !== undefined ? visible.opacity : 1;
    let color = a < 1 ? rgbaToString(visible.color.r, visible.color.g, visible.color.b, a) : hex;

    if (node.boundVariables && node.boundVariables.strokes && node.boundVariables.strokes.length > 0) {
      color = await resolveColorVariable(node.boundVariables.strokes[0], color);
    } else {
      const strokeStyleId = "strokeStyleId" in node ? node.strokeStyleId : null;
      if (strokeStyleId && strokeStyleId !== "" && strokeStyleId !== figma.mixed) {
        const resolvedStyle = await resolveStyleById(strokeStyleId);
        if (resolvedStyle) color = `var(${resolvedStyle.name}, ${color})`;
      }
    }

    const weight = "strokeWeight" in node ? node.strokeWeight : 1;
    const strokeWeightVar = getBoundVariable(node, "strokeWeight");
    const weightStr = strokeWeightVar ? await resolveNumericVariable(strokeWeightVar, weight) : px(weight);

    props.push(`border-width: ${weightStr}`);
    props.push(`border-color: ${color}`);
    props.push(`border-style: solid`);
  }

  if ("strokeAlign" in node && node.strokeAlign) {
    const alignMap = { INSIDE: "inside", OUTSIDE: "outside", CENTER: "center" };
    props.push(`border-position: ${alignMap[node.strokeAlign] || "center"}`);
  }

  if ("strokeCap" in node && node.strokeCap && node.strokeCap !== "NONE" && node.strokeCap !== figma.mixed) {
    const capMap = { ROUND: "round", SQUARE: "square" };
    if (capMap[node.strokeCap]) props.push(`stroke-linecap: ${capMap[node.strokeCap]}`);
  }

  if ("strokeJoin" in node && node.strokeJoin) {
    const joinMap = { MITER: "miter", BEVEL: "bevel", ROUND: "round" };
    if (joinMap[node.strokeJoin]) props.push(`stroke-linejoin: ${joinMap[node.strokeJoin]}`);
  }

  if ("dashPattern" in node && node.dashPattern && node.dashPattern.length > 0) {
    const styleIdx = props.findIndex((p) => p.startsWith("border-style:"));
    if (styleIdx >= 0) props[styleIdx] = `border-style: dashed`;
    props.push(`stroke-dasharray: ${node.dashPattern.join(" ")}`);
  }

  return props;
}

// --- Border radius ---

async function extractBorderRadius(node) {
  if (!("cornerRadius" in node)) return null;
  const r = node.cornerRadius;

  if (r === figma.mixed) {
    const tl = node.topLeftRadius || 0;
    const tr = node.topRightRadius || 0;
    const br = node.bottomRightRadius || 0;
    const bl = node.bottomLeftRadius || 0;

    const tlVar = getBoundVariable(node, "topLeftRadius");
    const trVar = getBoundVariable(node, "topRightRadius");
    const brVar = getBoundVariable(node, "bottomRightRadius");
    const blVar = getBoundVariable(node, "bottomLeftRadius");

    const tlStr = tlVar ? await resolveNumericVariable(tlVar, tl) : px(tl);
    const trStr = trVar ? await resolveNumericVariable(trVar, tr) : px(tr);
    const brStr = brVar ? await resolveNumericVariable(brVar, br) : px(br);
    const blStr = blVar ? await resolveNumericVariable(blVar, bl) : px(bl);

    return `${tlStr} ${trStr} ${brStr} ${blStr}`;
  }

  if (typeof r === "number" && r > 0) {
    const radiusVar = getBoundVariable(node, "cornerRadius");
    if (radiusVar) return await resolveNumericVariable(radiusVar, r);
    return px(r);
  }
  return null;
}

// --- Effects ---

async function extractEffects(node) {
  if (!("effects" in node)) return [];
  const effects = node.effects;
  if (!Array.isArray(effects)) return [];

  const effectStyleId = "effectStyleId" in node ? node.effectStyleId : null;
  const hasEffectStyle = effectStyleId && effectStyleId !== "" && effectStyleId !== figma.mixed;

  const results = [];
  const shadowValues = [];

  for (const fx of effects) {
    if (!fx.visible) continue;
    if (fx.type === "DROP_SHADOW" || fx.type === "INNER_SHADOW") {
      const c = rgbaToString(fx.color.r, fx.color.g, fx.color.b, fx.color.a);
      const inset = fx.type === "INNER_SHADOW" ? "inset " : "";
      shadowValues.push(`${inset}${px(fx.offset.x)} ${px(fx.offset.y)} ${px(fx.radius)} ${px(fx.spread || 0)} ${c}`);
    } else if (fx.type === "LAYER_BLUR") {
      results.push(`filter: blur(${px(fx.radius)})`);
    } else if (fx.type === "BACKGROUND_BLUR") {
      results.push(`backdrop-filter: blur(${px(fx.radius)})`);
    }
  }

  if (shadowValues.length > 0) {
    const rawShadow = shadowValues.join(", ");
    if (hasEffectStyle) {
      const resolvedStyle = await resolveStyleById(effectStyleId);
      if (resolvedStyle) {
        results.unshift(`box-shadow: var(${resolvedStyle.name}, ${rawShadow})`);
      } else {
        results.unshift(`box-shadow: ${rawShadow}`);
      }
    } else {
      results.unshift(`box-shadow: ${rawShadow}`);
    }
  }

  return results;
}

// --- Layout ---

async function extractLayout(node) {
  if (!("layoutMode" in node)) return [];
  if (node.layoutMode === "NONE") return [];

  const props = [];
  props.push(`display: flex`);
  props.push(`flex-direction: ${node.layoutMode === "HORIZONTAL" ? "row" : "column"}`);

  const gapVar = getBoundVariable(node, "itemSpacing");
  props.push(`gap: ${gapVar ? await resolveNumericVariable(gapVar, node.itemSpacing) : px(node.itemSpacing)}`);

  const pt = node.paddingTop || 0;
  const pr = node.paddingRight || 0;
  const pb = node.paddingBottom || 0;
  const pl = node.paddingLeft || 0;

  if (pt || pr || pb || pl) {
    const ptVar = getBoundVariable(node, "paddingTop");
    const prVar = getBoundVariable(node, "paddingRight");
    const pbVar = getBoundVariable(node, "paddingBottom");
    const plVar = getBoundVariable(node, "paddingLeft");
    const hasAnyVar = ptVar || prVar || pbVar || plVar;

    if (hasAnyVar) {
      const ptStr = ptVar ? await resolveNumericVariable(ptVar, pt) : px(pt);
      const prStr = prVar ? await resolveNumericVariable(prVar, pr) : px(pr);
      const pbStr = pbVar ? await resolveNumericVariable(pbVar, pb) : px(pb);
      const plStr = plVar ? await resolveNumericVariable(plVar, pl) : px(pl);
      props.push(`padding: ${ptStr} ${prStr} ${pbStr} ${plStr}`);
    } else {
      if (pt === pb && pl === pr && pt === pl) {
        props.push(`padding: ${px(pt)}`);
      } else if (pt === pb && pl === pr) {
        props.push(`padding: ${px(pt)} ${px(pr)}`);
      } else {
        props.push(`padding: ${px(pt)} ${px(pr)} ${px(pb)} ${px(pl)}`);
      }
    }
  }

  const justifyMap = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" };
  const alignMap = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" };
  const j = justifyMap[node.primaryAxisAlignItems];
  const a = alignMap[node.counterAxisAlignItems];
  if (j && j !== "flex-start") props.push(`justify-content: ${j}`);
  if (a && a !== "flex-start") props.push(`align-items: ${a}`);
  if (node.layoutWrap === "WRAP") props.push(`flex-wrap: wrap`);

  return props;
}

// --- Sizing ---

async function extractSizing(node) {
  const props = [];
  let w, h;

  if ("layoutSizingHorizontal" in node) {
    if (node.layoutSizingHorizontal === "FIXED") {
      const wVar = getBoundVariable(node, "width");
      w = wVar ? await resolveNumericVariable(wVar, Math.round(node.width)) : px(Math.round(node.width));
    } else if (node.layoutSizingHorizontal === "FILL") w = "fill (100%)";
    else if (node.layoutSizingHorizontal === "HUG") w = "fit-content";
  } else {
    const wVar = getBoundVariable(node, "width");
    w = wVar ? await resolveNumericVariable(wVar, Math.round(node.width)) : px(Math.round(node.width));
  }

  if ("layoutSizingVertical" in node) {
    if (node.layoutSizingVertical === "FIXED") {
      const hVar = getBoundVariable(node, "height");
      h = hVar ? await resolveNumericVariable(hVar, Math.round(node.height)) : px(Math.round(node.height));
    } else if (node.layoutSizingVertical === "FILL") h = "fill (100%)";
    else if (node.layoutSizingVertical === "HUG") h = "fit-content";
  } else {
    const hVar = getBoundVariable(node, "height");
    h = hVar ? await resolveNumericVariable(hVar, Math.round(node.height)) : px(Math.round(node.height));
  }

  props.push(`width: ${w}`);
  props.push(`height: ${h}`);
  return props;
}

// --- Transform ---

function extractTransform(node) {
  const props = [];
  if ("rotation" in node && node.rotation !== 0) {
    props.push(`transform: rotate(${roundValue(-node.rotation)}deg)`);
  }
  return props;
}

function extractBlendMode(node) {
  if (!("blendMode" in node)) return null;
  if (node.blendMode === "NORMAL" || node.blendMode === "PASS_THROUGH") return null;
  const modeMap = {
    MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay",
    DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge",
    COLOR_BURN: "color-burn", HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light",
    DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue",
    SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity"
  };
  return modeMap[node.blendMode] || null;
}

// --- Text ---

async function extractTextProps(node) {
  const lines = [];

  try {
    const segments = node.getStyledTextSegments([
      "fontName", "fontSize", "fontWeight", "lineHeight",
      "letterSpacing", "fills", "textDecoration", "textCase",
      "listOptions", "indentation"
    ]);

    if (segments.length === 1) {
      const seg = segments[0];
      lines.push(`font-family: ${seg.fontName.family}`);
      lines.push(`font-size: ${px(seg.fontSize)}`);
      lines.push(`font-weight: ${seg.fontName.style}`);

      if (seg.lineHeight && typeof seg.lineHeight === "object") {
        if (seg.lineHeight.unit === "PIXELS") lines.push(`line-height: ${px(roundValue(seg.lineHeight.value))}`);
        else if (seg.lineHeight.unit === "PERCENT") lines.push(`line-height: ${roundValue(seg.lineHeight.value)}%`);
        else lines.push(`line-height: normal`);
      }

      if (seg.letterSpacing && typeof seg.letterSpacing === "object" && seg.letterSpacing.value !== 0) {
        if (seg.letterSpacing.unit === "PIXELS") lines.push(`letter-spacing: ${px(roundValue(seg.letterSpacing.value))}`);
        else lines.push(`letter-spacing: ${roundValue(seg.letterSpacing.value)}%`);
      }

      if (seg.textDecoration && seg.textDecoration !== "NONE") {
        const decMap = { UNDERLINE: "underline", STRIKETHROUGH: "line-through" };
        lines.push(`text-decoration: ${decMap[seg.textDecoration] || seg.textDecoration.toLowerCase()}`);
      }

      if (seg.textCase && seg.textCase !== "ORIGINAL") {
        const caseMap = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize", SMALL_CAPS: "small-caps" };
        if (caseMap[seg.textCase]) lines.push(`text-transform: ${caseMap[seg.textCase]}`);
      }

      if (seg.listOptions && seg.listOptions.type && seg.listOptions.type !== "NONE") {
        const listMap = { ORDERED: "decimal", UNORDERED: "disc" };
        lines.push(`list-style-type: ${listMap[seg.listOptions.type] || seg.listOptions.type.toLowerCase()}`);
      }

    } else if (segments.length > 1) {
      lines.push(`font-family: ${segments[0].fontName.family}`);
      lines.push(`font-size: ${px(segments[0].fontSize)}`);
      lines.push(`font-weight: ${segments[0].fontName.style}`);

      if (segments[0].lineHeight && typeof segments[0].lineHeight === "object") {
        if (segments[0].lineHeight.unit === "PIXELS") lines.push(`line-height: ${px(roundValue(segments[0].lineHeight.value))}`);
        else if (segments[0].lineHeight.unit === "PERCENT") lines.push(`line-height: ${roundValue(segments[0].lineHeight.value)}%`);
      }

      const hasLists = segments.some((s) => s.listOptions && s.listOptions.type && s.listOptions.type !== "NONE");
      if (hasLists) {
        const listType = segments.find((s) => s.listOptions && s.listOptions.type !== "NONE");
        if (listType) {
          const listMap = { ORDERED: "decimal", UNORDERED: "disc" };
          lines.push(`list-style-type: ${listMap[listType.listOptions.type] || "none"}`);
        }
      }

      lines.push(`mixed-styles: ${segments.length} segments`);
      for (const seg of segments) {
        const preview = seg.characters.substring(0, 50).replace(/\n/g, "\\n");
        lines.push(`  "${preview}${seg.characters.length > 50 ? "..." : ""}" → ${seg.fontName.family} ${seg.fontName.style}, ${seg.fontSize}px`);
      }
    }
  } catch (e) {
    if (node.fontName !== figma.mixed) {
      lines.push(`font-family: ${node.fontName.family}`);
      lines.push(`font-size: ${px(node.fontSize)}`);
      lines.push(`font-weight: ${node.fontName.style}`);
    } else {
      lines.push(`font: (mixed styles)`);
    }
  }

  const alignMap = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
  lines.push(`text-align: ${alignMap[node.textAlignHorizontal] || "left"}`);

  const vAlignMap = { TOP: "top", CENTER: "middle", BOTTOM: "bottom" };
  if (node.textAlignVertical && node.textAlignVertical !== "TOP") {
    lines.push(`vertical-align: ${vAlignMap[node.textAlignVertical] || "top"}`);
  }

  if (node.textTruncation === "ENDING") {
    lines.push(`text-overflow: ellipsis`);
    lines.push(`overflow: hidden`);
    lines.push(`white-space: nowrap`);
  }

  if ("maxLines" in node && node.maxLines !== null && node.maxLines > 0) {
    lines.push(`-webkit-line-clamp: ${node.maxLines}`);
  }

  return lines;
}

// --- Main recursive parser ---

async function parseNode(node, depth, onlyVisible, parentIsAutoLayout) {
  if (onlyVisible && !node.visible) return "";
  if (depth > 10) return "";

  const indent = "  ".repeat(depth);
  const heading = "#".repeat(Math.min(depth + 1, 6));
  let md = "";

  const nodeType = formatNodeType(node.type);
  md += `\n${indent}${heading} Layer: ${node.name}\n`;
  md += `${indent}- type: ${nodeType}\n`;

  if (node.type === "TEXT") {
    md += `${indent}- content: "${node.characters}"\n`;
  }

  if (node.type === "INSTANCE") {
    try {
      const mainComp = await withTimeout(node.getMainComponentAsync(), 2000);
      if (mainComp) md += `${indent}- component: ${mainComp.name}\n`;
    } catch (e) {
      md += `${indent}- component: (external)\n`;
    }
  }

  if (node.type === "COMPONENT") {
    md += `${indent}- role: component-definition\n`;
  }

  const mediaInfo = getImageFillInfo(node);
  if (mediaInfo) {
    md += `${indent}- media: ${mediaInfo.type}\n`;
    md += `${indent}- object-fit: ${mediaInfo.scaleMode}\n`;
  }

  if (isSvgExportable(node)) {
    md += `${indent}- render: svg\n`;
    const svgCode = await exportSvgString(node);
    if (svgCode) {
      if (svgCode.length <= 5000) {
        const svgOneLine = svgCode.replace(/\n/g, " ").replace(/\s{2,}/g, " ");
        md += `${indent}- svg-code: "${svgOneLine}"\n`;
      } else {
        md += `${indent}- svg-code: (too large - ${Math.round(svgCode.length / 1024)}kb)\n`;
      }
    }
  }

  const sizing = await extractSizing(node);
  for (const prop of sizing) { md += `${indent}- ${prop}\n`; }

  const isAbsolute = "layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE";
  if (isAbsolute) {
    md += `${indent}- position: absolute\n`;
    md += `${indent}- top: ${px(Math.round(node.y))}\n`;
    md += `${indent}- left: ${px(Math.round(node.x))}\n`;
  } else if (!parentIsAutoLayout) {
    md += `${indent}- x: ${Math.round(node.x)}\n`;
    md += `${indent}- y: ${Math.round(node.y)}\n`;
  }

  const transforms = extractTransform(node);
  for (const t of transforms) { md += `${indent}- ${t}\n`; }

  if (node.opacity !== undefined && node.opacity < 1) {
    const opacityVar = getBoundVariable(node, "opacity");
    if (opacityVar) {
      const resolved = await resolveVariableById(opacityVar.id);
      if (resolved) md += `${indent}- opacity: var(${resolved.name}, ${roundValue(node.opacity)})\n`;
      else md += `${indent}- opacity: ${roundValue(node.opacity)}\n`;
    } else {
      md += `${indent}- opacity: ${roundValue(node.opacity)}\n`;
    }
  }

  const blendMode = extractBlendMode(node);
  if (blendMode) md += `${indent}- mix-blend-mode: ${blendMode}\n`;

  if ("clipsContent" in node && node.clipsContent) {
    md += `${indent}- overflow: hidden\n`;
  }

  if ("isMask" in node && node.isMask) {
    md += `${indent}- clip-path: mask-layer\n`;
  }

  const layoutProps = await extractLayout(node);
  for (const prop of layoutProps) { md += `${indent}- ${prop}\n`; }

  const fillResult = await extractFillWithContext(node);
  if (fillResult) md += `${indent}- ${fillResult.property}: ${fillResult.value}\n`;

  const strokeProps = await extractStroke(node);
  for (const prop of strokeProps) { md += `${indent}- ${prop}\n`; }

  const radius = await extractBorderRadius(node);
  if (radius) md += `${indent}- border-radius: ${radius}\n`;

  const effects = await extractEffects(node);
  for (const fx of effects) { md += `${indent}- ${fx}\n`; }

  if (node.type === "TEXT") {
    const textProps = await extractTextProps(node);
    for (const prop of textProps) { md += `${indent}- ${prop}\n`; }
  }

  const thisIsAutoLayout = "layoutMode" in node && node.layoutMode !== "NONE";
  if ("children" in node) {
    for (const child of node.children) {
      md += await parseNode(child, depth + 1, onlyVisible, thisIsAutoLayout);
    }
  }

  return md;
}

// --- Selection listener ---

figma.on("selectionchange", () => {
  const selection = figma.currentPage.selection;
  if (selection.length > 0) {
    figma.ui.postMessage({ type: "selection", name: selection[0].name });
  } else {
    figma.ui.postMessage({ type: "selection", name: null });
  }
});

setTimeout(() => {
  const selection = figma.currentPage.selection;
  figma.ui.postMessage({ type: "selection", name: selection.length > 0 ? selection[0].name : null });
}, 100);

// --- Message handler ---

figma.ui.onmessage = async (msg) => {
  if (msg.type === "generate") {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: "error", message: "No frame selected. Please select a frame first." });
      return;
    }

    const selectedUnit = msg.unit || "px";
    const rootNode = selection[0];
    ROOT_SIZE = { width: Math.round(rootNode.width), height: Math.round(rootNode.height) };

    variableCache.clear();
    styleCache.clear();

    let markdown = "";

    for (const node of selection) {
      UNIT = selectedUnit;

      const nodeType = formatNodeType(node.type);
      markdown += `# Frame: ${node.name}\n`;
      markdown += `- type: ${nodeType}\n`;

      // Width and height of root frame always in px (reference values)
      markdown += `- width: ${Math.round(node.width)}px\n`;
      markdown += `- height: ${Math.round(node.height)}px\n`;

      const fillResult = await extractFillWithContext(node);
      if (fillResult) markdown += `- ${fillResult.property}: ${fillResult.value}\n`;

      const mediaInfo = getImageFillInfo(node);
      if (mediaInfo) {
        markdown += `- media: ${mediaInfo.type}\n`;
        markdown += `- object-fit: ${mediaInfo.scaleMode}\n`;
      }

      const radius = await extractBorderRadius(node);
      if (radius) markdown += `- border-radius: ${radius}\n`;

      const strokeProps = await extractStroke(node);
      for (const prop of strokeProps) { markdown += `- ${prop}\n`; }

      const layoutProps = await extractLayout(node);
      for (const prop of layoutProps) { markdown += `- ${prop}\n`; }

      const effects = await extractEffects(node);
      for (const fx of effects) { markdown += `- ${fx}\n`; }

      if ("clipsContent" in node && node.clipsContent) {
        markdown += `- overflow: hidden\n`;
      }

      const blendMode = extractBlendMode(node);
      if (blendMode) markdown += `- mix-blend-mode: ${blendMode}\n`;

      const rootIsAutoLayout = "layoutMode" in node && node.layoutMode !== "NONE";

      if ("children" in node) {
        for (const child of node.children) {
          markdown += await parseNode(child, 1, msg.onlyVisible || false, rootIsAutoLayout);
        }
      }
    }

    markdown = markdown.trim();
    figma.ui.postMessage({ type: "result", markdown });
  }
};

