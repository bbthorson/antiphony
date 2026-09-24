/**
 * ESLint rule: antiphony/no-hardcoded-design-tokens
 *
 * Enforces use of Antiphony design system tokens (var(--ap-*)) by banning
 * hardcoded hex, rgb, and hsl color values in style objects, JSX style props,
 * and color attributes.
 *
 * ## Why
 *
 * Antiphony's "Two Voices" visual language requires strict consistency between
 * the Call (Indigo) and Response (Coral) ramps, with full WCAG AA contrast
 * compliance across light and dark themes. Hardcoded colors fragment the UI,
 * break dark mode theming, and bypass contrast guarantees.
 *
 * ## Fires on
 *
 *   style={{ color: "#4f46e5" }}
 *   style={{ backgroundColor: "rgb(249, 115, 98)" }}
 *   const styles = { borderColor: "#cbd5e1" }
 *
 * ## Does NOT fire on
 *
 *   style={{ color: "var(--ap-call)" }}
 *   style={{ backgroundColor: "var(--ap-surface-card)" }}
 *   style={{ color: "inherit" }}
 *   style={{ color: "currentColor" }}
 *   style={{ color: "transparent" }}
 *   Anchor hrefs like <a href="#lexicons">
 */

const COLOR_HEX_REGEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FUNC_REGEX = /^(rgb|rgba|hsl|hsla)\(/i;

const STYLE_COLOR_PROPERTIES = new Set([
    "color",
    "background",
    "backgroundColor",
    "borderColor",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
    "outlineColor",
    "fill",
    "stroke",
    "boxShadow",
    "textDecorationColor",
]);

/**
 * Checks if a string value looks like a hardcoded color that should be a token.
 */
function isHardcodedColor(val) {
    if (typeof val !== "string") return false;
    const trimmed = val.trim();
    if (trimmed.startsWith("var(--ap-") || trimmed.startsWith("var(--sl-")) {
        return false;
    }
    if (["transparent", "inherit", "initial", "unset", "currentColor", "none"].includes(trimmed)) {
        return false;
    }
    if (COLOR_HEX_REGEX.test(trimmed)) {
        return true;
    }
    if (COLOR_FUNC_REGEX.test(trimmed)) {
        return true;
    }
    return false;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
    meta: {
        type: "problem",
        docs: {
            description: "Enforce Antiphony design tokens; ban hardcoded hex and rgb colors in style definitions.",
            category: "Best Practices",
            recommended: true,
        },
        schema: [],
        messages: {
            useToken:
                "Hardcoded color '{{raw}}' violates the design system. Use a design token var(--ap-*) from @antiphony/tokens instead.",
        },
    },

    create(context) {
        return {
            Property(node) {
                const keyName =
                    node.key.type === "Identifier"
                        ? node.key.name
                        : node.key.type === "Literal"
                          ? String(node.key.value)
                          : null;

                if (!keyName || !STYLE_COLOR_PROPERTIES.has(keyName)) {
                    return;
                }

                if (node.value.type === "Literal" && isHardcodedColor(node.value.value)) {
                    context.report({
                        node: node.value,
                        messageId: "useToken",
                        data: { raw: String(node.value.value) },
                    });
                }
            },

            JSXAttribute(node) {
                if (node.name.name !== "style" || !node.value) {
                    return;
                }

                // style="#fff" (literal string in JSX attribute)
                if (node.value.type === "Literal" && isHardcodedColor(node.value.value)) {
                    context.report({
                        node: node.value,
                        messageId: "useToken",
                        data: { raw: String(node.value.value) },
                    });
                }
            },
        };
    },
};

export default rule;
