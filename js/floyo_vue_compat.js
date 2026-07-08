import { app } from "../../scripts/app.js";
import { createModuleLogger } from "./log_system/log_funcs.js";

/*
 * Floyo Vue-nodes compatibility shim (additive, non-invasive).
 *
 * Some ComfyUI frontends run LiteGraph in "Vue nodes" mode
 * (LiteGraph.vueNodesMode === true), where each node is rendered as a
 * DOM/Vue component and the legacy per-node canvas hook `onDrawForeground`
 * is never called. Resolution Master paints its entire UI in
 * `onDrawForeground` and hides all of its real widgets, so in Vue-nodes
 * mode the node renders as an empty box.
 *
 * This shim renders the existing UI through a single custom widget (the
 * pattern Vue-nodes mode supports) and bridges pointer events back to the
 * node's existing handlers. It only activates when Vue-nodes mode is on;
 * in classic canvas mode the node keeps working exactly as upstream, so
 * this file is a pure addition that stays easy to sync.
 */

const log = createModuleLogger('floyo_vue_compat');

function isVueNodesMode() {
    try {
        const LG = globalThis.LiteGraph || app?.canvas?.constructor?.LiteGraph;
        if (typeof LG?.vueNodesMode === "boolean") return LG.vueNodesMode;
    } catch (error) { /* ignore */ }
    try {
        if (typeof app?.canvas?.vueNodesMode === "boolean") return app.canvas.vueNodesMode;
    } catch (error) { /* ignore */ }
    return false;
}

function installVueCompat(node) {
    const rm = node.resolutionMaster;
    if (!rm || node.__rmVueCompatInstalled) return;
    node.__rmVueCompatInstalled = true;

    const trigger = () => { try { node.__rmUiWidget?.triggerDraw?.(); } catch (error) { /* ignore */ } };
    const neededHeight = () => {
        try { return Math.max(300, rm.calculateNeededHeight()); } catch (error) { return 400; }
    };
    const syncHeight = () => {
        const h = neededHeight();
        if (node.__rmUiWidget) node.__rmUiWidget.computedHeight = h;
        if (Array.isArray(node.size) && Math.abs(node.size[1] - h) > 1) {
            try {
                if (typeof node.setSize === "function") node.setSize([node.size[0], h]);
                else node.size[1] = h;
            } catch (error) { /* ignore */ }
            node.setDirtyCanvas?.(true, true);
        }
    };

    // The interface reserves a title-height gap at the top of its content
    // (getManualContentStartY = NODE_TITLE_HEIGHT + 2) because in classic
    // mode it paints over the whole node including the title. In Vue-nodes
    // mode the title is a separate DOM bar above the widget, so that gap is
    // dead space — collapse it to a small margin.
    if (!rm.__origGetManualContentStartY && typeof rm.getManualContentStartY === "function") {
        rm.__origGetManualContentStartY = rm.getManualContentStartY.bind(rm);
        rm.getManualContentStartY = function () { return 2; };
    }
    // In Vue-nodes mode the widget drives the node height, so disable the
    // legacy self-sizing that assumes the canvas onDrawForeground path.
    if (!rm.__origEnsureMinimumSize && typeof rm.ensureMinimumSize === "function") {
        rm.__origEnsureMinimumSize = rm.ensureMinimumSize.bind(rm);
        rm.ensureMinimumSize = () => {};
    }
    // Re-render the Vue widget canvas whenever the node asks for a redraw
    // (drag, auto-detect, property changes all funnel through this).
    if (!rm.__origRequestCanvasUpdate && typeof rm.requestCanvasUpdate === "function") {
        rm.__origRequestCanvasUpdate = rm.requestCanvasUpdate.bind(rm);
        rm.requestCanvasUpdate = function (...args) {
            const result = rm.__origRequestCanvasUpdate(...args);
            trigger();
            return result;
        };
    }
    // Collapse the (already hidden) real widgets so they don't add stray
    // height to the Vue layout.
    (node.widgets || []).forEach((widget) => {
        if (widget !== node.__rmUiWidget) widget.computeSize = () => [0, 0];
    });

    const uiWidget = {
        type: "custom",
        name: "RESOLUTION_MASTER_UI",
        // Not a serialized value widget.
        options: { serialize: false },
        computedHeight: neededHeight(),
        computeSize(width) {
            const h = neededHeight();
            this.computedHeight = h;
            return [width, h];
        },
        draw(ctx) {
            try { rm.drawInterface(ctx); } catch (error) { log.debug("drawInterface failed", error); }
        },
        mouse(event, pos, widgetNode) {
            const rmc = widgetNode.resolutionMaster;
            if (!rmc) return false;
            const canvas = app.canvas;
            const type = (event && event.type) || "";

            // The Vue widget reports `pos` in widget-content coordinates,
            // which is exactly the space drawInterface records its control
            // rects in. The node's handlers derive their coordinates from
            // `event.canvasX/Y - node.pos`, so synthesize an event whose
            // canvas coordinates map back to `pos`.
            const syntheticEvent = {
                type,
                canvasX: widgetNode.pos[0] + pos[0],
                canvasY: widgetNode.pos[1] + pos[1],
                button: event?.button ?? 0,
                buttons: event?.buttons ?? 0,
                shiftKey: !!event?.shiftKey,
                ctrlKey: !!event?.ctrlKey,
                altKey: !!event?.altKey,
                metaKey: !!event?.metaKey,
                clientX: event?.clientX ?? 0,
                clientY: event?.clientY ?? 0,
                target: event?.target,
                preventDefault() { event?.preventDefault?.(); },
                stopPropagation() { event?.stopPropagation?.(); },
                getModifierState(key) { return event?.getModifierState ? event.getModifierState(key) : false; }
            };

            let handled = false;
            try {
                if (type.includes("down")) {
                    handled = rmc.handleMouseDown(syntheticEvent, pos, canvas) || false;
                } else if (type.includes("move")) {
                    if (widgetNode.capture) handled = rmc.handleMouseMove(syntheticEvent, pos, canvas) || false;
                    else { rmc.handleMouseHover(syntheticEvent, pos, canvas); handled = false; }
                } else if (type.includes("up")) {
                    handled = rmc.handleMouseUp(syntheticEvent) || false;
                }
            } catch (error) {
                log.debug("mouse bridge failed", error);
            }

            try { syncHeight(); trigger(); } catch (error) { /* ignore */ }
            return handled;
        }
    };

    node.widgets = node.widgets || [];
    // Append (do not unshift) so the real, serialized widgets keep their
    // original indices and saved workflows restore their values correctly.
    node.widgets.push(uiWidget);
    node.__rmUiWidget = uiWidget;
    syncHeight();
    trigger();

    log.debug("Installed Vue-nodes compatibility widget", { nodeId: node.id ?? null });
}

function scheduleInstall(node) {
    if (!isVueNodesMode()) return; // classic canvas mode: node renders as-is upstream.
    const tryInstall = (attempt = 0) => {
        if (node.__rmVueCompatInstalled) return;
        // The ResolutionMaster canvas instance is created by the main
        // extension's onNodeCreated wrapper; wait for it before installing.
        if (node.resolutionMaster) { installVueCompat(node); return; }
        if (attempt > 30) { log.debug("resolutionMaster instance never appeared"); return; }
        requestAnimationFrame(() => tryInstall(attempt + 1));
    };
    tryInstall();
}

app.registerExtension({
    name: "azResolutionMaster.floyoVueCompat",
    // Patch the prototype so this fires on EVERY instantiation path
    // (menu add, drag, and — critically — loading saved workflows),
    // not just the app-level nodeCreated hook.
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "ResolutionMaster") return;
        const prevOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = prevOnNodeCreated ? prevOnNodeCreated.apply(this, arguments) : undefined;
            try { scheduleInstall(this); } catch (error) { log.debug("scheduleInstall failed", error); }
            return result;
        };
    },
    // Backup path for any instantiation flow that skips the prototype hook.
    async nodeCreated(node) {
        const nodeClass = node?.comfyClass || node?.constructor?.comfyClass || node?.type;
        if (nodeClass !== "ResolutionMaster") return;
        scheduleInstall(node);
    }
});
