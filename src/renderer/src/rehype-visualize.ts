import type { Element, ElementContent, Root } from "hast";
import type { VisualizeReplacement } from "./visualize-ref";

export function rehypeVisualizeRefs(replacements: VisualizeReplacement[] = []) {
  return (tree: Root) => {
    if (!replacements.length) return;
    const lookup = new Map(replacements.map(item => [item.token, item]));
    // Tokens contain only private-use delimiters, ASCII letters and digits.
    const pattern = new RegExp(`(${replacements.map(item => item.token).join("|")})`, "g");
    const restore = (text: string) => replacements.reduce((value, item) => value.replaceAll(item.token, item.raw).replaceAll(encodeURIComponent(item.token), item.raw), text);
    const visit = (node: Root | Element, literal: boolean) => {
      if (node.type === "element") {
        for (const [key, value] of Object.entries(node.properties)) if (typeof value === "string") node.properties[key] = restore(value);
      }
      const children = node.children as ElementContent[];
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (child.type === "element") {
          visit(child, literal || ["pre", "code", "a"].includes(child.tagName));
        } else if (child.type === "text") {
          if (literal) { child.value = restore(child.value); continue; }
          const parts = child.value.split(pattern);
          if (parts.length === 1) continue;
          const out: ElementContent[] = parts.filter(Boolean).map(value => {
            const item = lookup.get(value);
            return item ? { type: "element", tagName: "span", properties: { dataVisualizePath: item.path }, children: [{ type: "text", value: item.title ?? "" }] } : { type: "text", value };
          });
          children.splice(index, 1, ...out);
          index += out.length - 1;
        }
      }
    };
    visit(tree, false);
  };
}
