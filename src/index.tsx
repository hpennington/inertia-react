import React from 'react'
import {decode} from '@msgpack/msgpack'
import {InertiaAnimationSchema, MessageTranslation, MessageActionables, MessageActionable, InertiaSchemaWrapper, InertiaAnimationInvokeType, WebSocketClient, InertiaDataModel, inertiaTree, inertiaTreeFor, treeFor, inertiaSelection, inertiaSelectionReplacing, InertiaCanvasSize, MessageType, MessageWrapper, InertiaID, Tree, Node, ActionableIdPair, AnimationSignal, MessagePlaybackProgress, InertiaPlayback, authoredLoopDuration, valuesAtTime, sanitizeValues, InertiaShape, InertiaShapePosition, stackedShapes, Vertex, normalizedShapeTriangles, shapeBounds, hitTestShapes, shapeClipPath, inertiaFileExtension, InertiaTool, InertiaToolEdit, identityValues, noToolEdit, isNoToolEdit, addToolEdits, applyToolEdit, minimumToolScale, InertiaAnimationValues as InertiaAnimationValuesBase} from 'inertia-base'

export type InertiaContainerProps = {
    children: React.ReactElement,
    dev: boolean,
    id: string,
    /// The id of the container's own node in the hierarchy — the root every
    /// actionable inside it hangs from. Usually the same string as `id`.
    hierarchyId: string,
    baseURL: string,
}

export type InertiaProps = {
    children: React.ReactElement,
    /// The id this actionable's animation is authored against. Shared by every
    /// instance of it, and the same id `useInertia().trigger` and friends take.
    id: string,
}

export type InertiaActionableProps = {
    children: React.ReactElement,
    id: string,
}

type InertiaContextType = {
    inertiaDataModel: InertiaDataModel;
    setInertiaDataModel: React.Dispatch<React.SetStateAction<InertiaDataModel>>;
};

const InertiaContext = React.createContext<InertiaContextType | undefined>(undefined);

const useInertiaDataModel = (): InertiaContextType => {
    const context = React.useContext(InertiaContext);
    if (!context) {
        throw new Error('useInertiaDataModel must be used within a InertiaContext.Provider');
    }
    return context;
};

const InertiaParentIdContext = React.createContext<string|undefined>(undefined)


const useInertiaParentId = () => {
    const inertiaParentId = React.useContext(InertiaParentIdContext)

    if (!inertiaParentId) {
        throw new Error('useInertiaParentId must be used within a InertiaContext.Provider')
    }

    return inertiaParentId
}

const InertiaContainerIdContext = React.createContext<string|undefined>(undefined)


const useInertiaContainerId = () => {
    const inertiaContainerId = React.useContext(InertiaContainerIdContext)

    if (!inertiaContainerId) {
        throw new Error('useInertiaContainerId must be used within a InertiaContainerIdContext.Provider')
    }

    return inertiaContainerId
}

const InertiaIsContainerContext = React.createContext<boolean>(false)


const useInertiaIsContainer = () => {
    const inertiaIsContainer = React.useContext(InertiaIsContainerContext)

    if (!inertiaIsContainer) {
        throw new Error('useInertiaIsContainer must be used within a InertiaIsContainerContext.Provider')
    }

    return inertiaIsContainer
}

// --- MessageSelected ---
export type MessageSelected = {
    selectedIds: Set<ActionableIdPair>;
};

// --- Basic Types ---
export type CGPoint = { x: number; y: number };
export type CGSize = { width: number; height: number };

// --- Enum ---
export enum InertiaObjectType {
    Shape = "shape",
    Animation = "animation",
}

/// Re-exported from `inertia-base` rather than restated here.
///
/// These used to be declared a second time in this package, and one of them
/// disagreed with the original: `InertiaAnimationValues.translate` was a
/// `CGSize` here and the `[x, y]` pair it is on the wire there. Which of the two
/// a consumer got depended on which package they imported the name from, and the
/// two do not assign to each other — while everything in this file that actually
/// reads a `translate` (`renderNode`, the shape canvases) indexes it as a pair,
/// so the local declaration described a shape nothing produced.
export type {
    AnimationContainer,
    InertiaAnimationValues,
    InertiaAnimationKeyframe,
    MessageSchema,
} from 'inertia-base';

/// A fully collapsed transform: scaled to nothing and fully transparent. Not the
/// identity — see `sanitizeValues` in `inertia-base` for that.
export const zeroInertiaAnimationValues: InertiaAnimationValuesBase = {
    scale: 0,
    translate: [0, 0],
    rotate: 0,
    rotateCenter: 0,
    opacity: 0,
};

class SharedIndexManager {
    // The singleton instance
    private static _instance: SharedIndexManager;

    // Private constructor to prevent external instantiation
    private constructor() {}

    // Static getter to access the singleton
    public static get shared(): SharedIndexManager {
        if (!SharedIndexManager._instance) {
            SharedIndexManager._instance = new SharedIndexManager();
        }
        return SharedIndexManager._instance;
    }

    // Properties
    public indexMap: Record<string, number> = {};
    public objectIndexMap: Record<string, number> = {};
    public objectIdSet: Set<string> = new Set();
    /// Indices handed back by nodes that have gone away, per counter — see
    /// `releaseId`.
    private freeIndices: Record<string, number[]> = {};

    /// Separated, or container `ab` with prefix `c` and container `a` with
    /// prefix `bc` would share a counter. The separator is a character no
    /// authored id can hold, which is what makes the two halves unambiguous.
    private static key(containerId: string | undefined | null, prefix: string): string {
        return `${containerId ?? ""}${prefix}`;
    }

    /// Names the next instance of `prefix` in this container, and moves the
    /// counter along.
    ///
    /// Counted per container rather than per prefix alone: the index is what
    /// tells two instances of the same authored view apart, and two containers
    /// each holding one instance are not two instances. Sharing one counter had
    /// the second container's node come up as `card0--1` with no `card0--0`
    /// beside it, so a selection authored against the first container named
    /// nothing the second one drew.
    ///
    /// A released index is handed out again before a fresh one is taken, so a
    /// container gives the same names to the same views every time it draws
    /// them — see `releaseId`.
    public claimId(containerId: string | undefined | null, prefix: string): string {
        const key = SharedIndexManager.key(containerId, prefix);

        const free = this.freeIndices[key];
        if (free && free.length > 0) {
            free.sort((a, b) => a - b);
            return `${prefix}--${free.shift()!}`;
        }

        const index = this.indexMap[key] ?? 0;
        this.indexMap[key] = index + 1;
        return `${prefix}--${index}`;
    }

    /// Gives an index back, for the next view of this prefix in this container
    /// to take.
    ///
    /// The counter alone only ever climbs, and on this runtime a view that goes
    /// off screen is unmounted rather than kept alive the way SwiftUI's
    /// `TabView` keeps a tab that is not the selected one — so a tab visited a
    /// second time had its cards come back as `card0--1` and `card1--1`.
    /// Everything the editor holds is filed under the name the node had the
    /// first time: its row in the hierarchy, the selection, the mapping from
    /// actionable to animation. The second visit drew views the editor had
    /// never heard of, in a hierarchy still listing rows nothing on screen
    /// answered to.
    public releaseId(containerId: string | undefined | null, prefix: string, id: string): void {
        const separator = `${prefix}--`;
        if (!id.startsWith(separator)) return;

        const index = Number(id.slice(separator.length));
        if (!Number.isInteger(index)) return;

        const key = SharedIndexManager.key(containerId, prefix);
        const free = this.freeIndices[key] ?? (this.freeIndices[key] = []);
        if (!free.includes(index)) free.push(index);
    }
}

// ------------------ Playback ------------------

type RegisteredNode = {
    hierarchyIdPrefix: string;
    element: HTMLElement;
    /// A track the registered element carries itself, rather than one looked up
    /// by prefix: what a shape authored with an animation of its own is drawn
    /// from. The prefix is still the actionable it belongs to, which is what
    /// says whether that actionable has been triggered.
    schema?: InertiaAnimationSchema;
    /// Whether this is a shape rather than an actionable, which decides what a
    /// missing `schema` means. An actionable with no track of its own is drawn
    /// from the one its prefix names; a shape is drawn from its own or from
    /// nothing at all — the actionable's transform is already on the element
    /// this one sits inside, and drawing it again here would apply it twice.
    isShape?: boolean;
    /// Whether this element is taken off screen until the run is on it — a shape
    /// that appears with the animation rather than backing it, see
    /// `InertiaShape.showsBeforeAnimation`.
    ///
    /// Held here rather than read off the schema because it is not a schema
    /// question: whether a canvas is drawn at all is decided per frame, from the
    /// same clock its transform is, and React has no state that ticks with it.
    hidesBeforeAnimation?: boolean;
};

type ActionableState = {
    /// Whether the app has started this actionable. The editor can pause, seek
    /// and resume a run, but starting one is the app's call.
    trigger: boolean;
    isCancelled: boolean;
    /// Where the track is frozen after a triggered run has had its pass, in
    /// seconds into the loop — null while the animation is waiting, running, or
    /// being scrubbed.
    ///
    /// Ending a pass clears `trigger`, so the animation can be asked for again;
    /// on its own that would also take the node back to its initial values,
    /// since nothing but a running track draws anywhere else. It stays where the
    /// run left it instead, which is this: the frame it was showing when the
    /// pass ended, held until it is triggered again.
    heldTime?: number | null;
};

/// Owns the clock every actionable in a container is drawn from.
///
/// The editor's timeline and the animation on screen have to be the same thing,
/// so nothing here hands a track to the browser's animation engine and lets it
/// keep its own time — a run the editor cannot seek into is a run its playhead
/// can only guess at. Instead one clock ticks per frame, and every registered
/// element is written with the values its track reaches at the playhead.
/// Playing, pausing and scrubbing are then all the same operation.
export class InertiaPlaybackController {
    private nodes = new Map<string, RegisteredNode>();
    private schemas = new Map<string, InertiaAnimationSchema>();
    private states = new Map<string, ActionableState>();
    private canvasSize: InertiaCanvasSize | null = null;
    /// The editor's in-progress gestures, by node.
    ///
    /// Drawn here rather than as a transform on a wrapper around the node: what
    /// the editor is sent is a single set of values, and composing the gesture
    /// into the same matrix the schema is drawn with is what makes the node's
    /// appearance agree with them. A wrapper would multiply the two instead,
    /// which is a different transform whenever both are doing something.
    private edits = new Map<string, InertiaToolEdit>();
    /// What each node was last drawn at, gesture included — what the tool
    /// handles size themselves against and what the readout shows.
    private renderedValues = new Map<string, InertiaAnimationValuesBase>();

    /// How long one loop lasts.
    ///
    /// Seeded from the schemas — the loop is part of what was authored, so a
    /// shipped build loops over the span its animation was drawn against
    /// without anything having to tell it — and moved from there by the
    /// editor's timeline. Applies from the next frame, so resizing the timeline
    /// mid-run stretches the loop rather than waiting for it to be restarted.
    public loopDuration: number = InertiaPlayback.defaultLoopDuration;
    public playheadTime: number = 0;
    /// Whether a run is on screen: playing, or holding the frame it finished on.
    /// Not the same as the clock ticking — a run that has played once and
    /// stopped still holds its final values.
    public isRunning: boolean = false;
    /// Whether tracks repeat once they reach the end of the loop.
    ///
    /// Set by the app. A repeating run wraps at `playbackDuration` and every
    /// track is padded out to it, so actionables of different lengths restart
    /// together; a run that plays once stops at the end and holds there.
    public isRepeating: boolean = true;
    /// Where the editor has parked the playhead, while it is parked there.
    /// Non-nil means the run is being scrubbed or is paused rather than played.
    public seekTime: number | null = null;
    /// The `sequence` of the last signal applied, echoed back on every progress
    /// report so the editor can tell its own request's effect from a report
    /// still in flight from before it.
    public lastProcessedSignalSequence: number = 0;

    /// Called on every tick of the clock while running, and once more when a run
    /// stops. The container forwards these to the editor.
    public onProgress?: (progress: MessagePlaybackProgress) => void;

    private frameHandle: number | null = null;
    private runStartMs: number = 0;
    private runOffset: number = 0;

    /// One turn of the timeline: the loop the editor drew, or the longest track,
    /// whichever is longer. Anything recorded past the end of the loop stretches
    /// it, which keeps every track the same length as every other.
    ///
    /// Worked out by `InertiaPlayback.duration` rather than in here, so a canvas
    /// view drawing these schemas somewhere the app is not pads its tracks to the
    /// same turn and the two playheads mean the same thing.
    get playbackDuration(): number {
        return InertiaPlayback.duration(this.loopDuration, this.schemas.values());
    }

    /// Translations are stored normalized, so nothing can be drawn until the
    /// container has measured itself.
    public setCanvasSize(size: InertiaCanvasSize | null): void {
        this.canvasSize = size;
        this.render();
    }

    /// Replaces the schemas, keyed by hierarchy id prefix.
    ///
    /// `auto` animations start as soon as their schema arrives — the same set
    /// with the editor attached as without, which is what settles the race
    /// between a `resume` and the schemas it was sent alongside. Not if the
    /// editor has parked the playhead, where starting a run would take it away
    /// from whoever is scrubbing.
    ///
    /// An animation that is no longer in the set loses its playback state along
    /// with its track, rather than being left behind marked as running. Nothing
    /// is lost by it — a state for a prefix nothing holds a schema for reads
    /// exactly as one that has not been triggered — and an animation authored
    /// again under the same name starts from a state that agrees it has not run.
    public setSchemas(schemas: Map<string, InertiaAnimationSchema>): void {
        const previous = this.schemas;
        this.schemas = schemas;

        // Only what this held a schema for and no longer does. A state the app
        // put there itself — a `trigger()` or a `cancel()` for an animation
        // whose schema is still on its way — has never been in here, and
        // dropping it would lose the call.
        previous.forEach((_, prefix) => {
            if (!schemas.has(prefix)) {
                this.states.delete(prefix);
            }
        });

        // The loop travels with the schemas, so a project authored at a length
        // other than the default plays at it from the first send — and in a
        // shipped build, where no editor is ever going to say otherwise. An
        // empty set leaves the current loop alone rather than snapping back to
        // the default.
        const authored = authoredLoopDuration(schemas.values());
        if (authored !== null) {
            this.loopDuration = authored;
        }

        /// Whether this call is what started something, as opposed to finding it
        /// already started. Only a fresh trigger starts the clock: the schemas
        /// are handed over again on every write to the data model — selecting a
        /// node, flipping the editor's switch — and an actionable already marked
        /// triggered must not be started a second time by one of those. A run
        /// that has played once and is holding its final frame has a stopped
        /// clock but a set `trigger`, so starting on `hasTriggeredActionable`
        /// played it again from the top every time a node was clicked.
        let didTrigger = false;

        schemas.forEach((schema, prefix) => {
            if (!this.states.has(prefix)) {
                this.states.set(prefix, { trigger: false, isCancelled: false });
            }

            if (schema.invokeType === InertiaAnimationInvokeType.auto) {
                const state = this.states.get(prefix)!;
                if (!state.isCancelled && !state.trigger) {
                    state.trigger = true;
                    // Playing again is what lets go of the frame a finished pass
                    // was left holding.
                    state.heldTime = null;
                    didTrigger = true;
                }
            }
        });

        this.render();

        if (this.seekTime === null && didTrigger) {
            this.startClock();
        }
    }

    public registerNode(hierarchyId: string, hierarchyIdPrefix: string, element: HTMLElement): void {
        this.nodes.set(hierarchyId, { hierarchyIdPrefix, element });
        this.renderNode(hierarchyId);
    }

    /// Registers something drawn behind an actionable that moves on a track of
    /// its own — a shape authored with an animation attached.
    ///
    /// Drawn from the same clock as everything else, so a shape moves in time
    /// with the actionable it was authored behind rather than on a clock of its
    /// own. It is `hierarchyIdPrefix` that ties it to that actionable, and
    /// `schema` alone that says how it moves.
    ///
    /// A shape with no track registers too, when the editor has it selected: it
    /// stays where it was authored, but a gesture on it still has to move it,
    /// and this is what puts that gesture on screen. So does one that waits for
    /// the animation before it is drawn at all, whether or not it moves once it
    /// is — that is a decision taken per frame off this clock, and registering
    /// is how an element gets one. See `renderNode`.
    public registerShapeNode(
        id: string,
        hierarchyIdPrefix: string,
        element: HTMLElement,
        schema?: InertiaAnimationSchema,
        hidesBeforeAnimation?: boolean
    ): void {
        this.nodes.set(id, { hierarchyIdPrefix, element, schema, isShape: true, hidesBeforeAnimation });
        this.renderNode(id);
    }

    public unregisterNode(hierarchyId: string): void {
        const node = this.nodes.get(hierarchyId);
        if (node) {
            node.element.style.transform = "";
            node.element.style.opacity = "";
            node.element.style.visibility = "";
        }
        this.nodes.delete(hierarchyId);
        this.edits.delete(hierarchyId);
        this.renderedValues.delete(hierarchyId);
    }

    /// Shows what an editor gesture has produced so far on one node. Nothing is
    /// authored by this — the schema is unchanged until the editor sends one
    /// back — so it is dropped again the moment the gesture is let go and the
    /// edit it settled at arrives as `initialValues`.
    public setEdit(hierarchyId: string, edit: InertiaToolEdit | null): void {
        if (!edit || isNoToolEdit(edit)) {
            if (!this.edits.delete(hierarchyId)) return;
        } else {
            this.edits.set(hierarchyId, edit);
        }

        this.renderNode(hierarchyId);
    }

    /// What `hierarchyId` is currently drawn at. The identity transform for a
    /// node that has neither a schema nor a gesture, which is what an actionable
    /// nobody has animated yet is sitting at.
    public valuesFor(hierarchyId: string): InertiaAnimationValuesBase {
        return this.renderedValues.get(hierarchyId) ?? identityValues;
    }

    private get hasTriggeredActionable(): boolean {
        let triggered = false;
        this.states.forEach(state => {
            triggered = triggered || (state.trigger && !state.isCancelled);
        });
        return triggered;
    }

    // MARK: - App-facing controls

    /// Starts an animation that was waiting on its `trigger` invoke type.
    ///
    /// A trigger arriving while the animation is already running joins the run
    /// in progress rather than cutting it short — `restart()` is the one that
    /// starts over. Cancelled animations are left where they are: stopping one
    /// is the app's call, and picking it back up is `restart()`'s.
    public trigger(id: string): void {
        const state = this.states.get(id);
        if (state?.isCancelled === true || state?.trigger === true) {
            return;
        }

        this.start(id);
    }

    /// Stops an animation and returns it to its initial values, where it stays
    /// until `restart()`.
    ///
    /// The clock stops with the last animation running off it, since a playhead
    /// with nothing left to follow is one the editor should see parked. The
    /// cancellation is recorded whether or not this animation has a state entry
    /// yet, so cancelling before its schema lands still sticks.
    public cancel(id: string): void {
        this.states.set(id, { trigger: false, isCancelled: true });
        this.render();

        if (this.hasTriggeredActionable) {
            return;
        }

        this.stopClock();
        this.report(false);
    }

    /// Clears a cancellation and plays from the top of the timeline.
    ///
    /// Every actionable in a container is drawn from the one clock, so this
    /// rewinds the playhead for all of them rather than for this animation alone
    /// — the same shared clock that makes a trigger mid-run join the run in
    /// progress instead of restarting it.
    public restart(id: string): void {
        this.stopClock();
        this.playheadTime = 0;

        // The playhead is back at zero, which ends the pass of anything else
        // that was triggered — the same rule as everywhere else, so a restart
        // does not quietly carry another animation's run over the boundary.
        this.retireTriggeredAnimations(0);

        this.start(id);
    }

    /// Rewinds the playhead and plays every animation in this container from the
    /// top.
    ///
    /// What a container reaches for when it is handed a new `hierarchyId`: the
    /// screen just navigated to plays its animations again rather than showing
    /// the final frame of the run they finished the first time round. The same
    /// call as the SwiftUI runtime's `InertiaDataModel.restartAll()`.
    ///
    /// `invokeType` decides who plays, here as everywhere else. Arriving on a
    /// screen is the app deciding to show what is on it — it is not the
    /// `trigger()` call a `trigger` animation is still waiting for, and starting
    /// one here played animations the app had said it would start itself. Those
    /// are returned to their initial values instead, so the screen offers them
    /// from the top when the app does trigger them — the editor's Trigger action
    /// included, which is a `trigger()` call like any other.
    ///
    /// Every schema as well as every state, since an animation that has never
    /// run has no state to rewind and is exactly the one this has to start. A
    /// cancellation goes with the screen that was cancelled on: the app's next
    /// `trigger()` on this one is answered rather than dropped.
    public restartAll(): void {
        this.stopClock();
        this.playheadTime = 0;
        this.seekTime = null;

        let didStart = false;

        new Set([...this.states.keys(), ...this.schemas.keys()]).forEach(prefix => {
            const isAuto = this.schemas.get(prefix)?.invokeType === InertiaAnimationInvokeType.auto;

            this.states.set(prefix, { trigger: isAuto, isCancelled: false });
            didStart = didStart || isAuto;
        });

        this.render();

        // A screen of nothing but `trigger` animations has no run to follow, and
        // a clock started for it would report a playhead crossing a timeline
        // nothing is drawn from.
        if (!didStart) {
            this.report(false);
            return;
        }

        this.startClock();
    }

    public isCancelled(id: string): boolean {
        return this.states.get(id)?.isCancelled ?? false;
    }

    private start(id: string): void {
        this.states.set(id, { trigger: true, isCancelled: false, heldTime: null });
        this.seekTime = null;
        this.startClock();
    }

    /// Puts the `trigger` animations that have played their pass back to
    /// waiting, holding each where `time` leaves it.
    ///
    /// A trigger is answered once. The run it asked for ends when the playhead
    /// goes back to zero — the loop coming round, or the editor's transport
    /// being touched — and the animation has to be asked for again, rather than
    /// repeating for as long as the screen is up with a second `trigger()` left
    /// with nothing to do.
    ///
    /// What ends is the run, not what is on screen: `heldTime` is the frame the
    /// animation was showing at that moment, and it stays on it until the next
    /// trigger replays it. Every caller passes the playhead the node is drawn
    /// at, so nothing moves at the instant a pass ends.
    ///
    /// The clock goes down with the last thing running off it, the same as a
    /// cancellation. Reporting that is left to the caller, each of which is
    /// about to say something about the run anyway.
    private retireTriggeredAnimations(time: number): void {
        this.states.forEach((state, prefix) => {
            if (this.schemas.get(prefix)?.invokeType !== InertiaAnimationInvokeType.trigger) {
                return;
            }

            if (!state.trigger) {
                return;
            }

            state.trigger = false;
            state.heldTime = time;
        });

        if (this.hasTriggeredActionable) {
            return;
        }

        this.stopClock();
    }

    /// Where to read `prefix`'s track, or null when its run is not on screen at
    /// all and the animation is drawn at the values it starts from.
    ///
    /// The one answer to both halves of that question, so whether a track shows
    /// and where it has got to can never disagree. Three states in it: a run on
    /// screen — playing, or parked in the track by the editor — reads at the
    /// playhead; a triggered run that has had its pass holds the frame it ended
    /// on, whatever the playhead does afterwards, until it is triggered again;
    /// anything else is not drawn from its track.
    private trackTime(prefix: string): number | null {
        const state = this.states.get(prefix);
        if (!state || state.isCancelled) {
            return null;
        }

        if (state.heldTime !== null && state.heldTime !== undefined) {
            return state.heldTime;
        }

        // Scrubbing shows the animation without running it.
        if (!state.trigger || (!this.isRunning && this.seekTime === null)) {
            return null;
        }

        return this.seekTime ?? this.playheadTime;
    }

    // MARK: - Editor signals

    public applySignal(signal: AnimationSignal, sequence: number): void {
        this.lastProcessedSignalSequence = sequence;

        switch (signal.type) {
            case "pause":
                this.pausePlayback();
                break;
            case "resume":
                this.resumePlayback();
                break;
            case "seek":
                this.seek(signal.time);
                break;
            case "setLoopDuration":
                this.loopDuration = InertiaPlayback.clampLoopDuration(signal.duration);
                this.render();
                break;
            // The app's own entry point, reached by the editor's Trigger action
            // standing in for the app — a `trigger` animation starts the one way
            // whoever is watching it in the editor is authoring it to start.
            case "trigger":
                this.trigger(signal.id);
                break;
        }
    }

    /// Stops the run and reports where it stopped, so a paused playhead sits
    /// exactly where the animation froze — for the `auto` animations. A
    /// triggered one has had its pass ended by the transport being touched at
    /// all, so it holds the frame it is on until it is asked for again.
    private pausePlayback(): void {
        this.retireTriggeredAnimations(this.playheadTime);
        this.stopClock();
        this.seekTime = this.playheadTime;
        this.render();
        this.report(false);
    }

    /// The editor's play button: picks a paused or scrubbed run back up where it
    /// was left, and starts the animations that start themselves.
    ///
    /// The `auto` ones, which mostly started as soon as their schema did. A
    /// `trigger` animation goes on waiting for the app to call `trigger()` — and
    /// one that was mid-pass is put back to waiting, since pressing play is
    /// asking for the run the timeline describes rather than for the one a
    /// trigger asked for. Standing in for the app is the editor's Trigger
    /// action's job, and it arrives as its own signal rather than riding along
    /// with this.
    ///
    /// Cancelled animations are left where they are: stopping one is the app's
    /// call, and picking it back up is `restart()`'s.
    private resumePlayback(): void {
        const wasRunning = this.isRunning;

        // Unparked before the bail-out below, not after: a play following a
        // pause has to release the playhead even when the schemas it applies to
        // have not arrived yet, or `setSchemas` finds it still parked and
        // declines to start the run.
        this.seekTime = null;

        this.retireTriggeredAnimations(this.playheadTime);

        this.schemas.forEach((schema, prefix) => {
            if (schema.invokeType !== InertiaAnimationInvokeType.auto) {
                return;
            }

            const state = this.states.get(prefix);
            if (!state || state.isCancelled || state.trigger) {
                return;
            }

            state.trigger = true;
            state.heldTime = null;
        });

        // Nothing to play: either the schemas this request arrived ahead of will
        // start themselves in `setSchemas`, which is where the race above is
        // settled, or everything here is waiting on a trigger this is not —
        // worth saying if it means a run just ended.
        if (!this.hasTriggeredActionable) {
            this.render();
            if (wasRunning) {
                this.report(false);
            }
            return;
        }

        this.startClock();
    }

    /// Freezes the animation at `time`. The editor is the one moving the
    /// playhead here, so this does not report back: the position it would send
    /// is the one it just asked for.
    private seek(time: number): void {
        this.stopClock();

        const clamped = Math.min(Math.max(time, 0), this.playbackDuration);

        // Back at the start of the timeline, which is where a pass ends however
        // the playhead got there — see `retireTriggeredAnimations`.
        if (clamped === 0) {
            this.retireTriggeredAnimations(0);
        }

        this.seekTime = clamped;
        this.playheadTime = clamped;
        this.render();
    }

    // MARK: - The clock

    /// Times the run that just started.
    ///
    /// Actionables trigger one at a time, so a trigger arriving while the clock
    /// is already running joins the run in progress rather than restarting it.
    /// Playing picks up from wherever the playhead was left — scrubbed to, or
    /// paused at — rather than from the top; only a playhead parked at the very
    /// end of the loop starts over, since there is nothing left to play.
    private startClock(): void {
        if (this.frameHandle !== null) {
            return;
        }

        // Nothing loaded yet: there is no animation for the playhead to follow.
        if (this.schemas.size === 0) {
            return;
        }

        const duration = this.playbackDuration;
        this.runOffset = this.playheadTime < duration ? this.playheadTime : 0;
        this.playheadTime = this.runOffset;
        this.isRunning = true;
        this.runStartMs = performance.now();

        this.render();
        this.report(true);

        this.frameHandle = requestAnimationFrame(this.tick);
    }

    private stopClock(): void {
        if (this.frameHandle !== null) {
            cancelAnimationFrame(this.frameHandle);
            this.frameHandle = null;
        }
        this.isRunning = false;
    }

    private tick = (now: number): void => {
        this.frameHandle = null;

        if (!this.isRunning) {
            return;
        }

        // Read each frame: the timeline can be resized mid-run.
        const duration = this.playbackDuration;
        const elapsed = this.runOffset + (now - this.runStartMs) / 1000;

        // A run that plays once ends here, holding its final frame: no further
        // frame is requested, but `isRunning` stays set so the run stays on
        // screen. Starting it again is the app's call. Nothing retires here,
        // because the playhead stops at the end of the loop rather than coming
        // back round to the start of it.
        if (!this.isRepeating && elapsed >= duration) {
            this.playheadTime = duration;
            this.render();
            this.report(false);
            return;
        }

        const wrapped = duration > 0 ? elapsed % duration : 0;

        // The timeline has come round, so whatever was triggered has had the
        // pass it was triggered for. Held at the end of the loop, which is the
        // frame it is on as it comes round.
        if (wrapped < this.playheadTime) {
            this.retireTriggeredAnimations(duration);

            if (!this.isRunning) {
                this.playheadTime = wrapped;
                this.render();
                this.report(false);
                return;
            }
        }

        this.playheadTime = wrapped;
        this.render();
        this.report(true);

        this.frameHandle = requestAnimationFrame(this.tick);
    };

    private report(isRunning: boolean): void {
        this.onProgress?.({
            time: this.playheadTime,
            duration: this.playbackDuration,
            isRunning,
            lastProcessedSequence: this.lastProcessedSignalSequence,
        });
    }

    /// Tears the clock down. Called when the container unmounts, so a stray
    /// frame callback cannot keep writing to detached elements.
    public dispose(): void {
        this.stopClock();
        this.onProgress = undefined;
        this.nodes.clear();
    }

    // MARK: - Drawing

    /// Redraws every registered node at the current playhead. Public so a
    /// setting changed while the clock is stopped still reaches the screen.
    public render(): void {
        this.nodes.forEach((_, hierarchyId) => this.renderNode(hierarchyId));
    }

    private renderNode(hierarchyId: string): void {
        const node = this.nodes.get(hierarchyId);
        if (!node || !this.canvasSize) {
            return;
        }

        const edit = this.edits.get(hierarchyId) ?? null;
        const schema = node.schema ?? (node.isShape ? undefined : this.schemas.get(node.hierarchyIdPrefix));

        // Scrubbing shows the animation without running it and a finished pass
        // holds the frame it ended on, which is why one read answers both — see
        // `trackTime`.
        const actionableTime = this.trackTime(node.hierarchyIdPrefix);
        // A shape's own track does not share its actionable's `invokeType`: one
        // marked `auto` runs as soon as the clock does, even while the
        // actionable it backs is still waiting on the app to trigger it, and is
        // scrubbed with the playhead like anything else. A shape given a
        // `trigger` animation waits for that actionable, which is the only
        // trigger a shape can be reached by — and is held with it, since the
        // frame the actionable is holding is the one the shape was drawn on.
        const isShapeAuto = !!node.schema
            && node.schema.invokeType === InertiaAnimationInvokeType.auto
            && (this.isRunning || this.seekTime !== null);
        const trackTime = actionableTime ?? (isShapeAuto ? this.seekTime ?? this.playheadTime : null);
        const isShowingTrack = trackTime !== null;

        // A shape that appears with the animation rather than backing it — see
        // `InertiaShape.showsBeforeAnimation`. Decided ahead of the track,
        // because a shape with no track of its own still has to be taken off
        // screen, and hidden rather than unmounted so it keeps its canvas and
        // the GPU buffer behind it across a run.
        if (node.hidesBeforeAnimation) {
            node.element.style.visibility = isShowingTrack ? "" : "hidden";
        }

        if (!schema) {
            // Still drawn when the editor is dragging it: an actionable nobody
            // has animated yet has no schema until the first gesture is written
            // into one, and it has to move under the cursor before then. Same
            // for a shape authored as backdrop, which has no track until the
            // first edit on it is written into one.
            if (!edit) {
                this.renderedValues.delete(hierarchyId);
                node.element.style.transform = "";
                node.element.style.opacity = "";
                return;
            }

            this.write(hierarchyId, node, applyToolEdit(identityValues, edit, this.canvasSize));
            return;
        }

        const base = trackTime !== null
            ? valuesAtTime(schema, trackTime, this.playbackDuration, this.isRepeating)
            : sanitizeValues(schema.initialValues);

        this.write(hierarchyId, node, applyToolEdit(base, edit, this.canvasSize));
    }

    /// Puts one set of values on screen.
    private write(hierarchyId: string, node: RegisteredNode, values: InertiaAnimationValuesBase): void {
        if (!this.canvasSize) {
            return;
        }

        this.renderedValues.set(hierarchyId, values);

        // Written outermost-first, which is the order the SwiftUI runtime stacks
        // its modifiers in — offset, then rotateCenter, then rotate, then scale —
        // so the same schema composes the same matrix on both.
        //
        // `rotate` pivots on the top left corner while every other function here
        // pivots on the center, and an element has one transform-origin. Wrapping
        // it in a half-box translation and its inverse walks the pivot out to the
        // corner and back, which is what SwiftUI's `anchor: .topLeading` does. The
        // percentages resolve against this element's own border box, so the pair
        // cancels exactly and a `rotate` of 0 leaves the matrix untouched.
        node.element.style.transform = [
            `translateX(${values.translate[0] * this.canvasSize.width}px)`,
            `translateY(${values.translate[1] * this.canvasSize.height}px)`,
            `rotate(${values.rotateCenter}deg)`,
            `translate(-50%, -50%)`,
            `rotate(${values.rotate}deg)`,
            `translate(50%, 50%)`,
            `scale(${values.scale})`,
        ].join(" ");
        node.element.style.transformOrigin = "center";
        node.element.style.opacity = `${values.opacity}`;
    }
}

const InertiaPlaybackContext = React.createContext<InertiaPlaybackController | null>(null);

/// The app's handle on playback: start an animation the schema left waiting,
/// stop one, or start it over.
///
/// The same surface the SwiftUI runtime reaches through
/// `@Environment(\.inertiaDataModel)` and the Compose runtime through
/// `LocalInertia.current` — `isRepeating` and `loopDuration` are properties
/// rather than setter functions so an app reads the same on all three.
export type InertiaPlaybackHandle = {
    trigger(id: string): void;
    cancel(id: string): void;
    restart(id: string): void;
    /// Plays this container's animations from the top. What a `hierarchyId`
    /// change does on its own, and what an app that navigates without changing
    /// one can call itself.
    restartAll(): void;
    isCancelled(id: string): boolean;
    /// Whether tracks repeat once they reach the end of the loop. On by
    /// default; turn it off for animations that play once.
    isRepeating: boolean;
    /// How long one loop lasts, as set on the editor's timeline. Applies from
    /// the next frame, so resizing it mid-run stretches the loop rather than
    /// waiting for the run to be restarted.
    loopDuration: number;
    /// How far into the run currently on screen we are, in seconds.
    readonly playheadTime: number;
    /// Where the editor has parked the playhead, while it is parked there.
    /// Non-null means the run is being scrubbed or paused rather than played.
    readonly seekTime: number | null;
};

export const useInertia = (): InertiaPlaybackHandle => {
    const controller = React.useContext(InertiaPlaybackContext);

    if (!controller) {
        throw new Error('useInertia must be used within an InertiaContainer');
    }

    // Accessors rather than a snapshot: the controller drives the screen
    // imperatively, so a value copied out here would be stale by the next frame.
    return React.useMemo(() => ({
        trigger: (id: string) => controller.trigger(id),
        cancel: (id: string) => controller.cancel(id),
        restart: (id: string) => controller.restart(id),
        restartAll: () => controller.restartAll(),
        isCancelled: (id: string) => controller.isCancelled(id),
        get isRepeating() { return controller.isRepeating; },
        set isRepeating(value: boolean) {
            controller.isRepeating = value;
            // Redraws, so toggling this while paused takes effect on screen
            // rather than waiting for the next tick that isn't coming.
            controller.render();
        },
        get loopDuration() { return controller.loopDuration; },
        set loopDuration(value: number) {
            controller.loopDuration = value;
            controller.render();
        },
        get playheadTime() { return controller.playheadTime; },
        get seekTime() { return controller.seekTime; },
    }), [controller]);
};

/// Takes the whole project from the editor, in place of the one this container
/// was drawing.
///
/// Replaced rather than merged in: the editor sends every animation it has on
/// every edit, so the message says what the project *is*, not what changed in
/// it. Merged in, an animation deleted in the editor had nothing to say — the
/// wrapper for it simply stopped arriving — and the app under test went on
/// playing it until it was rebuilt. Same for a shape or a keypoint dropped from
/// one, which travel inside their schema.
///
/// Only what the editor sends is ever in here to lose: a container in `dev`
/// loads nothing off the network, and a shipped build never opens the socket
/// this arrives on.
function handleMessageSchema(
    schemaWrappers: InertiaSchemaWrapper[],
    inertiaDataModel: InertiaDataModel | null,
    setInertiaDataModel: React.Dispatch<React.SetStateAction<InertiaDataModel>>
): void {
    console.log(`[INERTIA_LOG]: [handleMessageSchema] Received ${schemaWrappers.length} schema wrappers`);

    if (!inertiaDataModel) {
        console.log(`[INERTIA_LOG]: [handleMessageSchema] ❌ No inertiaDataModel!`);
        return;
    }

    const inertiaSchemas = new Map<string, InertiaAnimationSchema>();
    const actionableIdToAnimationIdMap = new Map<string, string>();

    for (const schemaWrapper of schemaWrappers) {
        console.log(
            `[INERTIA_LOG]: [handleMessageSchema] wrapper - containerId: ${schemaWrapper.container.containerId}, actionableId: ${schemaWrapper.actionableId}, animationId: ${schemaWrapper.animationId}`
        );
        console.log(`[INERTIA_LOG]: [handleMessageSchema] schema:`, schemaWrapper.schema);
        console.log(`[INERTIA_LOG]: [handleMessageSchema] my containerId: ${inertiaDataModel.containerId}`);

        if (schemaWrapper.container.containerId === inertiaDataModel.containerId) {
            // The mapping from actionable ID to animation ID
            actionableIdToAnimationIdMap.set(schemaWrapper.actionableId, schemaWrapper.animationId);
            // The schema, by its animation ID
            inertiaSchemas.set(schemaWrapper.animationId, schemaWrapper.schema);

            console.log(
                `[INERTIA_LOG]: ✅ stored schema - animationId: ${schemaWrapper.animationId} actionableId: ${schemaWrapper.actionableId}, keyframes: ${schemaWrapper.schema.keyframes?.length ?? 0}`
            );
        } else {
            console.log(`[INERTIA_LOG]: ❌ skipped - container mismatch (wanted: ${schemaWrapper.container.containerId}, have: ${inertiaDataModel.containerId})`);
        }
    }

    console.log(`[INERTIA_LOG]: actionableIdToAnimationIdMap:`, Object.fromEntries(actionableIdToAnimationIdMap));
    console.log(`[INERTIA_LOG]: inertiaSchemas keys:`, Array.from(inertiaSchemas.keys()));

    setInertiaDataModel(prev => ({ ...prev, inertiaSchemas, actionableIdToAnimationIdMap }));
}

// ------------------ Alignment grid ------------------

/// Where the node being dragged sits in the container's coordinate space. An
/// absolute position rather than a translation: guides are drawn from it, and a
/// node need not be laid out at the container's center.
export type InertiaGuides = {
  center: { x: number; y: number };
  size: { width: number; height: number };
};

/// The alignment overlay's state, held per container and written by the
/// actionable being dragged.
///
/// Kept out of `InertiaDataModel` on purpose: that model is replaced on every
/// write, and the container resets each actionable's drag position whenever it
/// changes — so routing a drag through it would snap the node back to the origin
/// on every pointer move. Only the overlay subscribes here, so a drag repaints
/// the guides and leaves the rest of the tree alone.
export class InertiaGuideStore {
  private guides: InertiaGuides | null = null;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): InertiaGuides | null => this.guides;

  show(center: { x: number; y: number }, size: { width: number; height: number }): void {
    this.guides = { center, size };
    this.emit();
  }

  hide(): void {
    if (!this.guides) return;
    this.guides = null;
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach(listener => listener());
  }
}

const InertiaGuidesContext = React.createContext<InertiaGuideStore | null>(null);

const GUIDE_COLOR = "cyan";
const CROSSHAIR_COLOR = "red";

/// Dashed guides tracking the dragged node's edges and center within the
/// container, over a crosshair through the container's own center.
///
/// Laid out in percentages so it needs no size of its own: the container is the
/// SVG's viewport, and the guide offsets are already in its coordinate space.
const InertiaAlignmentGrid: React.FC<{ store: InertiaGuideStore }> = ({ store }) => {
  const guides = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!guides) return null;

  const { center, size } = guides;
  // A node measured before its first layout, or mid-teardown, has nothing to
  // draw guides against.
  if (!(size.width > 0) || !(size.height > 0)) return null;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;

  const xs = [center.x - size.width / 2, center.x, center.x + size.width / 2];
  const ys = [center.y - size.height / 2, center.y, center.y + size.height / 2];
  const guideProps = (isCenter: boolean) => ({
    stroke: GUIDE_COLOR,
    strokeWidth: 1,
    strokeOpacity: isCenter ? 1 : 0.5,
    strokeDasharray: isCenter ? undefined : "4 4",
  });

  return (
    <svg
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <line x1="50%" y1="0" x2="50%" y2="100%" stroke={CROSSHAIR_COLOR} strokeWidth={1} />
      <line x1="0" y1="50%" x2="100%" y2="50%" stroke={CROSSHAIR_COLOR} strokeWidth={1} />

      {xs.map((x, index) => (
        <line key={`x-${index}`} x1={x} y1="0" x2={x} y2="100%" {...guideProps(index === 1)} />
      ))}
      {ys.map((y, index) => (
        <line key={`y-${index}`} x1="0" y1={y} x2="100%" y2={y} {...guideProps(index === 1)} />
      ))}

      <rect
        x={center.x - size.width / 2}
        y={center.y - size.height / 2}
        width={size.width}
        height={size.height}
        fill="none"
        stroke={GUIDE_COLOR}
        strokeWidth={1}
        strokeDasharray="4 4"
      />
    </svg>
  );
};

export const InertiaContainer = ({ children, dev, id, hierarchyId, baseURL }: InertiaContainerProps): React.ReactElement => {
    const [inertiaDataModel, setInertiaDataModel] = React.useState(
        new InertiaDataModel(id, new Map())
    );
    const [bounds, setBounds] = React.useState<InertiaCanvasSize | null>(null);
    /// The hierarchies this container has built, one per `hierarchyId` it has
    /// been given. Made once and mutated in place, so it is what an effect that
    /// must not be torn down by an unrelated model update keys on — the model
    /// around it is replaced on every write.
    const trees = inertiaDataModel.trees;
    const ref = React.useRef<HTMLDivElement | null>(null);
    const controllerRef = React.useRef<InertiaPlaybackController | null>(null);
    if (controllerRef.current === null) {
        controllerRef.current = new InertiaPlaybackController();
    }
    const controller = controllerRef.current;

    const guidesRef = React.useRef<InertiaGuideStore | null>(null);
    if (guidesRef.current === null) {
        guidesRef.current = new InertiaGuideStore();
    }
    const guides = guidesRef.current;

    // Load animation schemas from the shipped animation file if not in dev mode
    React.useEffect(() => {
        console.log(`[INERTIA_LOG]: InertiaContainer init - dev: ${dev}, id: ${id}, baseURL: ${baseURL}`);

        if (dev) {
            console.log(`[INERTIA_LOG]: Dev mode enabled - schemas will be loaded via WebSocket`);
            return;
        }

        const fileName = `${id}.${inertiaFileExtension}`;
        console.log(`[INERTIA_LOG]: Production mode - attempting to load ${baseURL}/${fileName}`);

        const loadAnimations = async () => {
            try {
                const url = `${baseURL}/${fileName}`;
                console.log(`[INERTIA_LOG]: Fetching ${url}`);
                const response = await fetch(url);

                if (!response.ok) {
                    console.error(`[INERTIA_LOG]: Failed to load animation file: ${url} (status: ${response.status})`);
                    return;
                }

                // Read as bytes: the file is MessagePack, not text.
                const schemas = decode(new Uint8Array(await response.arrayBuffer())) as InertiaAnimationSchema[];
                console.log(`[INERTIA_LOG]: Loaded ${schemas.length} schemas from ${fileName}`, schemas);

                const schemaMap = new Map<string, InertiaAnimationSchema>();
                const actionableIdToAnimationIdMap = new Map<string, string>();

                for (const schema of schemas) {
                    // Store schema by its ID (hierarchyIdPrefix)
                    schemaMap.set(schema.id, schema);
                    // Map hierarchyIdPrefix to animationId
                    actionableIdToAnimationIdMap.set(schema.id, schema.id);
                    console.log(`[INERTIA_LOG]: Loaded schema - id: ${schema.id}, keyframes: ${schema.keyframes?.length ?? 0}`);
                }

                console.log(`[INERTIA_LOG]: Setting inertiaDataModel with ${schemaMap.size} schemas`);
                setInertiaDataModel(prev => ({
                    ...prev,
                    inertiaSchemas: schemaMap,
                    actionableIdToAnimationIdMap
                }));
            } catch (error) {
                console.error(`[INERTIA_LOG]: Error loading animation file ${fileName}:`, error);
            }
        };

        loadAnimations();
    }, [dev, baseURL, id]);

    React.useEffect(() => {
        if (!ref.current) return;

        const observer = new ResizeObserver((entries) => {
            const element = ref.current;
            if (!element) return;

            // The border box, not `entry.contentRect` — that is the *content*
            // box, so a container the host had put padding or a border on
            // measured smaller here than the same container does under
            // SwiftUI's `GeometryReader` or Compose's `onSizeChanged`, and one
            // authored `translate` moved the element a different distance on
            // each. `offsetWidth`/`offsetHeight` are the same box, and are what
            // `layoutSizeOf` already measures actionables with.
            const box = entries[0]?.borderBoxSize?.[0];
            setBounds({
                width: box ? box.inlineSize : element.offsetWidth,
                height: box ? box.blockSize : element.offsetHeight,
            });
        });

        observer.observe(ref.current);

        return () => {
            observer.disconnect();
        };
    }, []); // only run once

    // The canvas the normalized translations are resolved against.
    React.useEffect(() => {
        controller.setCanvasSize(bounds);
    }, [controller, bounds]);

    // Hand the playback controller the tracks it draws, resolved from the
    // actionable ids the app registered to the schemas the editor sent.
    //
    // Keyed on the two maps rather than on the model holding them: the model is
    // replaced wholesale on every write, so selecting a node or flipping the
    // editor's switch would hand the controller the same tracks again — and
    // handing over tracks is what starts an animation.
    React.useEffect(() => {
        const schemasByPrefix = new Map<string, InertiaAnimationSchema>();

        inertiaDataModel.actionableIdToAnimationIdMap.forEach((animationId, prefix) => {
            const schema = inertiaDataModel.inertiaSchemas.get(animationId);
            if (schema) {
                schemasByPrefix.set(prefix, schema);
            }
        });

        controller.setSchemas(schemasByPrefix);
    }, [controller, inertiaDataModel.actionableIdToAnimationIdMap, inertiaDataModel.inertiaSchemas]);

    React.useEffect(() => {
        return () => controller.dispose();
    }, [controller]);

    // ✅ WebSocket logic stays the same
    React.useEffect(() => {
        if (!dev) {
            console.log(`[INERTIA_LOG]: Not in dev mode, skipping WebSocket connection`);
            return;
        }

        const ws = WebSocketClient.shared;
        if (!inertiaDataModel) {
            console.log(`[INERTIA_LOG]: No inertiaDataModel, skipping WebSocket connection`);
            return;
        }

        // Where the editor's playhead comes from. Set before connecting: a run
        // can be under way before the socket is up, and reports are dropped
        // rather than queued while it is not.
        controller.onProgress = (progress) => {
            ws.sendMessagePlaybackProgress(progress);
        };

        console.log(`[INERTIA_LOG]: Connecting to WebSocket ws://127.0.0.1:8080`);
        ws.connect("ws://127.0.0.1:8080", () => {
            console.log(`[INERTIA_LOG]: WebSocket connected, setting up handlers`);

            // Filed under the hierarchy the editor named rather than over the
            // whole app: the editor draws one panel per hierarchy and writes a
            // selection back through the packet it was made in, so a message is
            // about one container. Laid over everything, picking a row in one
            // container silently cleared what was picked in every other.
            ws.messageReceived = (treeId, msg) => {
              console.log(`[INERTIA_LOG]: Received messageReceived for ${treeId} with ${msg.size} IDs`);

              setInertiaDataModel(prev => {
                const newPairs = new Set<ActionableIdPair>();

                // Each msg item is a hierarchyId
                for (const pair of msg) {
                  // Try to find prefix (optional: infer from tree or split)
                  newPairs.add({ hierarchyIdPrefix: pair.hierarchyIdPrefix, hierarchyId: pair.hierarchyId });
                }

                console.log("[INERTIA_LOG]: ✅ Updating actionableIdPairs from WS:", Array.from(newPairs));

                return {
                  ...prev,
                  actionableIdPairsByContainer: inertiaSelectionReplacing(prev, treeId, newPairs),
                };
              });
            };


            ws.messageReceivedSchema = (msg) => {
                console.log(`[INERTIA_LOG]: Received messageReceivedSchema`);
                handleMessageSchema(msg, inertiaDataModel, setInertiaDataModel)
            };

            ws.messageReceivedIsActionable = (msg) => {
                console.log(`[INERTIA_LOG]: Received messageReceivedIsActionable: ${msg}`);
                setInertiaDataModel(prev => ({ ...prev, isActionable: msg }));
            };

            ws.messageReceivedSignal = (signal, sequence) => {
                controller.applySignal(signal, sequence);
            };

            ws.messageReceivedTool = (tool) => {
                console.log(`[INERTIA_LOG]: Received messageReceivedTool: ${tool}`);
                setInertiaDataModel(prev => ({ ...prev, activeTool: tool }));
            };

        });
    }, [trees, hierarchyId, dev, controller]);

    /// Plays this container's animations again whenever the app hands it a new
    /// `hierarchyId`.
    ///
    /// A `hierarchyId` is what the app names the screen this container is
    /// currently showing, so a change of one is a navigation — and the screen
    /// arrived at should play its animations rather than show the last frame of
    /// the run they finished the first time it was up. The SwiftUI runtime
    /// restarts on the same signal.
    ///
    /// Not on the first `hierarchyId` this container is given: the animations of
    /// the screen the app opened on start themselves as their schemas arrive,
    /// and a restart on mount would cut that run short. The effect runs on mount
    /// all the same — React has no `onChange` — which is what the ref is for,
    /// and it also absorbs StrictMode's second pass.
    ///
    /// Keyed on the controller and the id alone: this must not be re-run by an
    /// unrelated model write, each of which would rewind a run in progress.
    const playedHierarchyId = React.useRef(hierarchyId);
    React.useEffect(() => {
        if (playedHierarchyId.current === hierarchyId) return;

        playedHierarchyId.current = hierarchyId;
        controller.restartAll();
    }, [controller, hierarchyId]);

    /// What the editor draws its hierarchy panel from.
    ///
    /// The selection as it stands when the message goes out rather than as it
    /// was when this was set up: the two halves of a `MessageActionables` are
    /// read together, and sending a stale selection beside a fresh tree tells the
    /// editor that what the user picked a moment ago is no longer picked.
    const selectionRef = React.useRef<Set<ActionableIdPair>>(new Set());
    selectionRef.current = inertiaSelection(inertiaDataModel, hierarchyId);

    /// Tells the editor what this container is showing, whenever that changes.
    ///
    /// A hierarchy is not built in one go — each actionable registers as it
    /// mounts, which is after this container's effects have run — so a message
    /// sent only when the socket opens carried whatever had registered by then.
    /// With a container whose `hierarchyId` changes, that is nothing at all: the
    /// tab being opened has its own empty tree at that moment, and the editor
    /// was left drawing the panel for a hierarchy it was never told the contents
    /// of.
    ///
    /// Coalesced to one message per microtask, because a screen's worth of
    /// actionables register one after another within a single commit and the
    /// editor only wants the hierarchy they add up to.
    React.useEffect(() => {
        if (!dev || !trees) return;

        const ws = WebSocketClient.shared;
        const tree = treeFor(trees, hierarchyId);

        const send = () => {
            ws.sendMessageActionables({
                tree,
                actionableIds: Array.from(selectionRef.current),
            });
        };

        let isScheduled = false;
        const schedule = () => {
            if (isScheduled) return;
            isScheduled = true;
            queueMicrotask(() => {
                isScheduled = false;
                send();
            });
        };

        const unsubscribe = tree.subscribe(schedule);
        // An editor that attaches later missed everything said before it was
        // listening, and the hierarchy will not change again just because one
        // turned up.
        const stopListening = ws.addConnectedListener(send);

        // What this container is showing as of now, for the hierarchy it has
        // just switched to.
        schedule();

        return () => {
            unsubscribe();
            stopListening();
        };
    }, [trees, hierarchyId, dev]);

    return (
        <InertiaCanvasSizeContext.Provider value={bounds}>
            {/* The frame the guides are measured against, and the one the overlay
                is positioned in, so a position taken in an actionable and a point
                drawn in the SVG share an origin.

                It is also the frame every animation is measured against: a
                `translate` of 1 crosses the whole container, so what the
                container *is* has to mean the same thing on every runtime or one
                authored animation moves a different distance on each. Filled,
                the way SwiftUI's `GeometryReader` reports the space offered and
                Compose's container takes it — a plain block div was as wide as
                its parent but only as tall as its content, which made a vertical
                `translate` resolve against a rectangle no other runtime had.

                `height: 100%` needs the host to have given whatever holds this a
                height of its own; without one it resolves to `auto` and the
                container falls back to hugging its content, which is where it
                started. That is the host's call to make, not something the
                runtime can force from in here. */}
            <div
                data-inertia-container-id={id}
                ref={ref}
                style={{ position: "relative", width: "100%", height: "100%" }}
            >
                <InertiaContainerElementContext.Provider value={ref}>
                    <InertiaPlaybackContext.Provider value={controller}>
                        <InertiaGuidesContext.Provider value={guides}>
                            <InertiaContext.Provider value={{ inertiaDataModel, setInertiaDataModel }}>
                                <InertiaParentIdContext.Provider value={hierarchyId}>
                                    <InertiaContainerIdContext.Provider value={hierarchyId}>
                                        <InertiaIsContainerContext.Provider value={true}>
                                            {children}
                                        </InertiaIsContainerContext.Provider>
                                    </InertiaContainerIdContext.Provider>
                                </InertiaParentIdContext.Provider>
                            </InertiaContext.Provider>
                        </InertiaGuidesContext.Provider>
                    </InertiaPlaybackContext.Provider>
                </InertiaContainerElementContext.Provider>
                <InertiaAlignmentGrid store={guides} />
            </div>
        </InertiaCanvasSizeContext.Provider>
    );
};


import { useState, useRef, useMemo, useCallback, useContext, useEffect } from "react";

const InertiaCanvasSizeContext = React.createContext<InertiaCanvasSize | null>(null)
const InertiaContainerElementContext = React.createContext<React.RefObject<HTMLDivElement> | null>(null)
const manager = WebSocketClient.shared

// ------------------ Draggable Props ------------------
export interface DraggableProps {
  hierarchyId?: string;
  hierarchyIdPrefix?: string;
  isSelected: boolean;
  actionableIdPairs?: Set<ActionableIdPair>;
  containerRef: React.RefObject<HTMLDivElement>;
  children: React.ReactNode;
  handleClick: () => void;
  inertiaDataModel?: InertiaDataModel;
  /// Everything the editor's gestures have added on top of this node's schema,
  /// still waiting for the editor to fold them in. The drag reports movement
  /// relative to its own start, so without carrying this every gesture after the
  /// first would snap the node back to where its schema puts it.
  edit: InertiaToolEdit;
  setEdit: React.Dispatch<React.SetStateAction<InertiaToolEdit>>;
  /// The values this node's schema starts it at, which an edit is measured from
  /// and which the editor is told the total of.
  initialValues?: InertiaAnimationValuesBase;
  moved?: React.MutableRefObject<boolean>;
  /// The chrome for the active tool. Built by the drag wrapper, which owns the
  /// gesture, and drawn by the wrapped component, which is inside everything
  /// that transforms the node — so the handles stay glued to it as it turns and
  /// scales.
  toolHandles?: React.ReactNode;
}

// ------------------ HOC ------------------
export interface DraggableInjectedProps {
  edit: InertiaToolEdit;
  setEdit: React.Dispatch<React.SetStateAction<InertiaToolEdit>>;
  moved: React.MutableRefObject<boolean>;
  toolHandles?: React.ReactNode;
}

// ------------------ Tool handles ------------------

const HANDLE_COLOR = "rgb(46, 182, 125)";
const HANDLE_ATTRIBUTE = "data-inertia-handle";

/// Which way one of the move tool's axis arrows lets a drag move the node.
///
/// The node's own body stays free in both directions; an arrow pins one component
/// of the drag to zero, for the moves that have to keep a row or a column. Screen
/// axes, not the node's own — the arrows are counter-rotated out of whatever the
/// node has been turned by, since horizontal and vertical are the screen's.
export type InertiaTranslateAxis = "horizontal" | "vertical";

const TRANSLATE_AXES: InertiaTranslateAxis[] = ["horizontal", "vertical"];

/// The value each arrow carries in `HANDLE_ATTRIBUTE`, which is how a press is
/// traced back to the axis it picked.
const axisHandleName = (axis: InertiaTranslateAxis): string => `translate-${axis}`;

/// The axis a press picked, or `null` for anywhere else — the body of the node
/// included, which is a free move.
const axisFromHandle = (name: string | null | undefined): InertiaTranslateAxis | null =>
  TRANSLATE_AXES.find((axis) => axisHandleName(axis) === name) ?? null;

/// The drag with the component this axis does not author dropped.
const constrainToAxis = (
  axis: InertiaTranslateAxis | null,
  delta: { x: number; y: number }
): { x: number; y: number } => {
  switch (axis) {
    case "horizontal":
      return { x: delta.x, y: 0 };
    case "vertical":
      return { x: 0, y: delta.y };
    default:
      return delta;
  }
};

/// A node scaled to nothing has no box left to grab. Chrome is divided through
/// by the scale the node is drawn at so it keeps its size on screen.
const chromeScaleFor = (scale: number): number =>
  Number.isFinite(scale) && scale > minimumToolScale ? 1 / scale : 1;

/// The handles a selected actionable shows for the active tool.
///
/// Rendered inside the node, so the browser's own transform carries them: a
/// rotation ring turns with what it turns, the way it does in the SwiftUI
/// runtime's overlay. Only the knobs take pointer events — the rings, tracks and
/// readout are decoration, and a gesture is opened by whichever knob was hit
/// (see `HANDLE_ATTRIBUTE`, which is what the drag wrapper looks for).
export const InertiaToolHandles: React.FC<{
  tool: InertiaTool;
  values: InertiaAnimationValuesBase;
  size: { width: number; height: number };
}> = ({ tool, values, size }) => {
  if (!(size.width > 0) || !(size.height > 0)) return null;

  const chrome = chromeScaleFor(values.scale);
  const knobRadius = 6 * chrome;
  const knobGap = 22 * chrome;
  const lineWidth = 1 * chrome;

  const center = { x: size.width / 2, y: size.height / 2 };

  const knob = (key: string, at: { x: number; y: number }) => (
    <div
      key={key}
      {...{ [HANDLE_ATTRIBUTE]: tool }}
      style={{
        position: "absolute",
        left: at.x - knobRadius,
        top: at.y - knobRadius,
        width: knobRadius * 2,
        height: knobRadius * 2,
        borderRadius: "50%",
        background: HANDLE_COLOR,
        border: `${lineWidth}px solid white`,
        boxSizing: "border-box",
        pointerEvents: "auto",
        cursor: "grab",
        touchAction: "none",
        // The knob is small and the gesture has to start on it; the hit area is
        // held out to a finger's worth however far the node has been scaled down.
        outline: `${knobRadius}px solid transparent`,
      }}
    />
  );

  const ring = (key: string, at: { x: number; y: number }, radius: number) => (
    <div
      key={key}
      style={{
        position: "absolute",
        left: at.x - radius,
        top: at.y - radius,
        width: radius * 2,
        height: radius * 2,
        borderRadius: "50%",
        border: `${lineWidth}px dashed ${HANDLE_COLOR}`,
        opacity: 0.6,
        boxSizing: "border-box",
        pointerEvents: "none",
      }}
    />
  );

  const parts: React.ReactNode[] = [];

  if (tool === InertiaTool.translate) {
    // From the node's edge out to an arrow's tail, and the head's own length and
    // half-width. Counter-scaled, so an arrow keeps its size on screen however
    // far the node has been scaled — the same as every other piece of chrome.
    const axisGap = 22 * chrome;
    const axisLength = 14 * chrome;
    const axisHalfWidth = 7 * chrome;
    /// How close a press has to land to an arrow to take it. Generous next to
    /// the arrow itself, which is small.
    const axisTouch = 24 * chrome;
    const stem = 2 * chrome;
    const axisParts: React.ReactNode[] = [];

    TRANSLATE_AXES.forEach((axis) => {
      const isHorizontal = axis === "horizontal";
      // The tail is where the stem ends and the head begins; the head runs
      // `axisLength` further out again.
      const tail = isHorizontal
        ? { x: size.width + axisGap, y: center.y }
        : { x: center.x, y: -axisGap };
      const arrow = isHorizontal
        ? { x: tail.x + axisLength / 2, y: tail.y }
        : { x: tail.x, y: tail.y - axisLength / 2 };

      axisParts.push(
        <div
          key={`stem-${axis}`}
          style={{
            position: "absolute",
            left: isHorizontal ? center.x : center.x - stem / 2,
            top: isHorizontal ? center.y - stem / 2 : tail.y,
            width: isHorizontal ? tail.x - center.x : stem,
            height: isHorizontal ? stem : center.y - tail.y,
            background: HANDLE_COLOR,
            opacity: 0.6,
            pointerEvents: "none",
          }}
        />
      );

      axisParts.push(
        // The head is a border triangle, which needs a box of its own with
        // nothing in it — so the hit area is this square around it rather than
        // the head's own 14 screen pixels.
        <div
          key={`axis-${axis}`}
          {...{ [HANDLE_ATTRIBUTE]: axisHandleName(axis) }}
          style={{
            position: "absolute",
            left: arrow.x - axisTouch,
            top: arrow.y - axisTouch,
            width: axisTouch * 2,
            height: axisTouch * 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "auto",
            cursor: "grab",
            touchAction: "none",
          }}
        >
          <div
            style={{
              width: 0,
              height: 0,
              // One head rather than two: both directions of an axis are
              // draggable, and the arrow only has to read as the axis it stands
              // for. Right for the horizontal one, up for the vertical one.
              borderTop: `${isHorizontal ? axisHalfWidth : 0}px solid transparent`,
              borderBottom: isHorizontal
                ? `${axisHalfWidth}px solid transparent`
                : `${axisLength}px solid ${HANDLE_COLOR}`,
              borderLeft: isHorizontal
                ? `${axisLength}px solid ${HANDLE_COLOR}`
                : `${axisHalfWidth}px solid transparent`,
              borderRight: `${isHorizontal ? 0 : axisHalfWidth}px solid transparent`,
            }}
          />
        </div>
      );
    });

    parts.push(
      // Turned back out of whatever the node has been turned by, as one group.
      // Undoing the sum of its two rotations about this group's own center leaves
      // that center exactly where the node's transform put it — a rotation fixes
      // its own anchor — and cancels the turn the arrows would otherwise inherit,
      // since a uniform scale commutes with a rotation. What is left points along
      // the screen's axes, which is what an arrow pins a move to.
      <div
        key="axes"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: size.width,
          height: size.height,
          transformOrigin: "center",
          transform: `rotate(${-(values.rotate + values.rotateCenter)}deg)`,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        {axisParts}
      </div>
    );
  }

  if (tool === InertiaTool.rotate) {
    // Out along the box's diagonal, so the knob reads as belonging to the corner
    // it turns about.
    const diagonal = Math.max(Math.hypot(size.width, size.height), 1);
    const at = {
      x: -(size.width / diagonal) * knobGap,
      y: -(size.height / diagonal) * knobGap,
    };
    parts.push(ring("ring", { x: 0, y: 0 }, Math.hypot(at.x, at.y)));
    parts.push(knob("knob", at));
  }

  if (tool === InertiaTool.rotateCenter) {
    parts.push(ring("ring", center, size.height / 2 + knobGap));
    parts.push(knob("knob", { x: center.x, y: -knobGap }));
  }

  if (tool === InertiaTool.scale) {
    const corners = [
      { x: 0, y: 0 },
      { x: size.width, y: 0 },
      { x: 0, y: size.height },
      { x: size.width, y: size.height },
    ];
    corners.forEach((corner, index) => parts.push(knob(`corner-${index}`, corner)));
  }

  if (tool === InertiaTool.opacity) {
    const width = Math.max(size.width, 60 * chrome);
    const height = 4 * chrome;
    const left = (size.width - width) / 2;
    const top = size.height + knobGap;
    const filled = width * Math.min(1, Math.max(0, values.opacity));

    parts.push(
      <div
        key="track"
        style={{
          position: "absolute",
          left,
          top,
          width,
          height,
          borderRadius: height,
          background: HANDLE_COLOR,
          opacity: 0.25,
          pointerEvents: "none",
        }}
      />
    );
    parts.push(
      <div
        key="fill"
        style={{
          position: "absolute",
          left,
          top,
          width: filled,
          height,
          borderRadius: height,
          background: HANDLE_COLOR,
          pointerEvents: "none",
        }}
      />
    );
    parts.push(knob("knob", { x: left + filled, y: top + height / 2 }));
  }

  const readout = (() => {
    switch (tool) {
      case InertiaTool.rotate:
        return `${values.rotate.toFixed(0)}°`;
      case InertiaTool.rotateCenter:
        return `${values.rotateCenter.toFixed(0)}°`;
      case InertiaTool.scale:
        return `${values.scale.toFixed(2)}×`;
      case InertiaTool.opacity:
        return `${(values.opacity * 100).toFixed(0)}%`;
      default:
        return null;
    }
  })();

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: size.width,
        height: size.height,
        // Every knob hangs outside the node's own box and has to stay both
        // visible and hittable.
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      {parts}

      {readout !== null && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: -knobGap - 30 * chrome,
            padding: `${4 * chrome}px ${9 * chrome}px`,
            borderRadius: 999,
            background: HANDLE_COLOR,
            color: "white",
            font: `600 ${17 * chrome}px ui-monospace, SFMono-Regular, Menlo, monospace`,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {readout}
        </div>
      )}
    </div>
  );
};

/// Where a gesture opened, taken once so its math stays measured against the
/// transform the node had before the drag rather than the one it is being given.
type ToolGestureStart = {
  /// The point the gesture turns or scales about, in the container's space.
  anchor: { x: number; y: number };
  /// The pointer's opening vector from `anchor`, which an angle or a distance
  /// ratio is taken relative to.
  reference: { x: number; y: number };
  /// The pointer's opening position, in the container's space.
  origin: { x: number; y: number };
  /// The axis the arrow this opened on pins a move to, for the move tool, and
  /// `null` for a press on the node itself — which is free in both. Taken at the
  /// press, because the arrow travels with the node the drag is moving.
  axis: InertiaTranslateAxis | null;
  /// The node's transform when the gesture began, and the edit already folded
  /// into it.
  values: InertiaAnimationValuesBase;
  edit: InertiaToolEdit;
  /// The transform this node was sitting inside when the gesture began. See
  /// `ToolGestureOptions.outer`.
  outer: InertiaAnimationValuesBase;
  /// The node's drawn center and laid-out size when the gesture began — what
  /// the guides are boxed against.
  center: { x: number; y: number };
  size: { width: number; height: number };
};

/// A drag measured on screen, restated in the space *inside* `outer` — which is
/// where an offset stacked under it is measured.
///
/// A shape is moved by an offset applied within the actionable's own rotation
/// and scale, so a drag to the right across a turned actionable is not a move to
/// the right in the space the shape's offset lands in. Undoing the turn and the
/// scale is what keeps the shape under the pointer. The Swift runtime's
/// `InertiaAnimationValues.unapplying`, corner for corner.
///
/// Nothing to undo for an actionable, which sits inside the identity.
const unapplyingOuter = (
  delta: { x: number; y: number },
  outer: InertiaAnimationValuesBase
): { x: number; y: number } => {
  const radians = (-(outer.rotate + outer.rotateCenter) * Math.PI) / 180;
  const divisor = Number.isFinite(outer.scale) && Math.abs(outer.scale) > minimumToolScale
    ? outer.scale
    : 1;

  return {
    x: (delta.x * Math.cos(radians) - delta.y * Math.sin(radians)) / divisor,
    y: (delta.x * Math.sin(radians) + delta.y * Math.cos(radians)) / divisor,
  };
};

/// What a node hands `useToolGesture` in order to be dragged by the active tool.
export type ToolGestureOptions = {
  /// What the playback controller knows this node as: where the values it is
  /// drawn at are read from, and where the gesture in progress is written back
  /// to so the node moves under the cursor. Undefined until the node has an id,
  /// which is a node that cannot be edited yet.
  nodeId?: string;
  /// The element the gesture measures. Its drawn box gives the center a
  /// rotation turns about; its laid-out box is what the handles are placed
  /// around.
  elementRef: React.RefObject<HTMLElement | null>;
  /// The values this node's schema starts it at, which an edit is measured from
  /// and which the editor is told the total of.
  initialValues?: InertiaAnimationValuesBase;
  /// The transform this node is drawn inside of, when it is drawn inside one at
  /// all: a shape sits within its actionable's, and an actionable sits within
  /// nothing. Left out is the identity.
  ///
  /// Two things need it. The corner a rotation turns about is derived from the
  /// measured center, and that derivation has to know the whole turn and scale
  /// the node is painted with rather than only its own; and a move is authored
  /// in the space *inside* this transform, which is not the space the pointer
  /// was measured in. See `unapplyingOuter`.
  outer?: InertiaAnimationValuesBase;
  /// Whether this node is the editor's to drag right now.
  canEdit: boolean;
  /// Which property a gesture authors, as picked in the editor's toolbar.
  tool: InertiaTool;
  edit: InertiaToolEdit;
  setEdit: React.Dispatch<React.SetStateAction<InertiaToolEdit>>;
  /// Hands the settled gesture to the editor, as the values the schema should
  /// be rewritten to. Whom the edit names is the caller's to say — an actionable
  /// sends the whole selection, a shape sends its own id.
  commit: (values: InertiaAnimationValuesBase) => void;
  /// Whether the editor's inspector is told where this node is as it moves.
  /// An actionable reports; a shape does not, matching the Swift runtime, where
  /// the properties message is the actionable's to send and a shape's gesture
  /// only records an edit.
  reportsProperties?: boolean;
};

/// One node's drag: the pointer handling, the tool math, and the chrome's
/// measurements.
///
/// Shared by the actionables — through `withDrag`, which is nothing more than
/// this hook wrapped around a component — and by the shapes drawn behind them,
/// which are dragged by exactly the same tools and report exactly the same
/// edit. The two differ only in what they are measured against and in whom the
/// resulting edit names, which is what `ToolGestureOptions` carries.
export function useToolGesture({
  nodeId,
  elementRef,
  initialValues,
  outer = identityValues,
  canEdit,
  tool,
  edit,
  setEdit,
  commit,
  reportsProperties = false,
}: ToolGestureOptions) {
  /// The whole node is the handle for the move tool, and only for it. Every
  /// other tool edits through its knobs, so a drag across the body of a node
  /// does nothing — the way a modal tool behaves in any other editor.
  const canDragBody = canEdit && tool === InertiaTool.translate;

  const start = useRef<ToolGestureStart | null>(null);
  const moved = useRef(false);
  /// Whether this press has actually dragged anything, as opposed to whether it
  /// still counts as a click. The two part company on a knob: a press on one is
  /// never a click — see `pointerHandlers` — but a press that never moved has
  /// authored nothing, and is not an edit to send.
  const dragged = useRef(false);
  /// The node's laid-out box, which is what the handles are placed around.
  /// Measured into state rather than read off the ref while rendering: a ref
  /// read is not reactive, so handles would keep the size the node had when
  /// something else last happened to re-render it.
  const [layoutBox, setLayoutBox] = useState({ width: 0, height: 0 });

  const inertiaCanvasSize = useContext(InertiaCanvasSizeContext);
  const inertiaContainerRef = useContext(InertiaContainerElementContext);
  const guides = useContext(InertiaGuidesContext);
  const controller = useContext(InertiaPlaybackContext);

  /// The node as it is drawn right now, gesture included — read from the
  /// controller, which is what put it there.
  const values = nodeId && controller ? controller.valuesFor(nodeId) : identityValues;

  /// Drawn by the controller in the same matrix as the schema, rather than as
  /// a transform on this wrapper: what the editor is sent is a single set of
  /// values, and stacking two transforms would not be the same transform.
  React.useLayoutEffect(() => {
    if (!controller || !nodeId) return;
    controller.setEdit(nodeId, canEdit ? edit : null);
  }, [controller, nodeId, edit, canEdit]);

  /// Where a point of the node's own laid-out box — origin at its top-left —
  /// is drawn in the container.
  ///
  /// Every transform in the stack is affine and all of them but the offset
  /// pivot somewhere inside the box, so the drawn box is the laid-out box
  /// scaled and turned about its own drawn center. That center is measured
  /// rather than derived, which keeps this honest whatever the page's layout
  /// has done with the node.
  const drawnPoint = (
    local: { x: number; y: number },
    center: { x: number; y: number },
    size: { width: number; height: number },
    at: InertiaAnimationValuesBase
  ) => {
    const radians = ((at.rotate + at.rotateCenter) * Math.PI) / 180;
    const dx = (local.x - size.width / 2) * at.scale;
    const dy = (local.y - size.height / 2) * at.scale;

    return {
      x: center.x + dx * Math.cos(radians) - dy * Math.sin(radians),
      y: center.y + dx * Math.sin(radians) + dy * Math.cos(radians),
    };
  };

  /// The pointer in the container's space. Measured there rather than in the
  /// node's own: the node is being moved by the very gesture being measured,
  /// and its coordinates move with it.
  const inContainerSpace = (clientX: number, clientY: number) => {
    const container = inertiaContainerRef?.current;
    if (!container) return { x: clientX, y: clientY };

    const rect = container.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const beginGesture = (
    clientX: number,
    clientY: number,
    axis: InertiaTranslateAxis | null
  ) => {
    const element = elementRef.current;
    const container = inertiaContainerRef?.current;
    if (!element || !container) return;

    const rect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // `getBoundingClientRect` reports what the browser has painted, so this is
    // the drawn box; `offsetWidth`/`offsetHeight` are the laid-out one, which
    // no transform touches. A rotated rectangle's bounding box is symmetric
    // about the rectangle's own center, so this center is exact.
    const center = {
      x: rect.left - containerRect.left + rect.width / 2,
      y: rect.top - containerRect.top + rect.height / 2,
    };
    const size = { width: element.offsetWidth, height: element.offsetHeight };
    const origin = { x: clientX - containerRect.left, y: clientY - containerRect.top };

    // Rotation about the top-left corner turns about that corner; everything
    // else pivots on the center. The corner is walked out from the measured
    // center through everything the node is painted with — its own transform
    // and whatever it is drawn inside of — since that is the box the corner is
    // a corner of.
    const anchor = tool === InertiaTool.rotate
      ? drawnPoint({ x: 0, y: 0 }, center, size, {
          ...values,
          rotate: values.rotate + outer.rotate,
          rotateCenter: values.rotateCenter + outer.rotateCenter,
          scale: values.scale * outer.scale,
        })
      : center;

    start.current = {
      anchor,
      reference: { x: origin.x - anchor.x, y: origin.y - anchor.y },
      origin,
      axis,
      values,
      edit,
      outer,
      center,
      size,
    };
    moved.current = false;
    dragged.current = false;
  };

  /// What the editor is told: the values this node's schema starts it at with
  /// everything the gestures have added folded in.
  const authoredValues = (next: InertiaToolEdit) =>
    applyToolEdit(initialValues ?? identityValues, next, inertiaCanvasSize ?? { width: 1, height: 1 });

  const angleOf = (vector: { x: number; y: number }) =>
    (Math.atan2(vector.y, vector.x) * 180) / Math.PI;

  /// The edit this gesture has reached, given where the pointer is now.
  const editAt = (point: { x: number; y: number }): InertiaToolEdit => {
    const opening = start.current;
    if (!opening) return edit;

    const current = { x: point.x - opening.anchor.x, y: point.y - opening.anchor.y };

    switch (tool) {
      case InertiaTool.translate: {
        // The body of the node moves freely; an axis arrow authors only its own
        // component of the same drag. Constrained on screen, where the arrows
        // are — they are counter-rotated out of whatever the node has been
        // turned by — and carried into the node's own space afterwards.
        const delta = unapplyingOuter(
          constrainToAxis(opening.axis, {
            x: point.x - opening.origin.x,
            y: point.y - opening.origin.y,
          }),
          opening.outer
        );

        return {
          ...opening.edit,
          translate: [
            opening.edit.translate[0] + delta.x,
            opening.edit.translate[1] + delta.y,
          ],
        };
      }

      case InertiaTool.rotate:
      case InertiaTool.rotateCenter: {
        const swept = angleOf(current) - angleOf(opening.reference);
        return tool === InertiaTool.rotate
          ? { ...opening.edit, rotate: opening.edit.rotate + swept }
          : { ...opening.edit, rotateCenter: opening.edit.rotateCenter + swept };
      }

      case InertiaTool.scale: {
        const reference = Math.hypot(opening.reference.x, opening.reference.y);
        if (!(reference > 1)) return opening.edit;

        const factor = Math.hypot(current.x, current.y) / reference;
        const scaled = Math.max(minimumToolScale, opening.values.scale * factor);
        return { ...opening.edit, scale: opening.edit.scale + (scaled - opening.values.scale) };
      }

      case InertiaTool.opacity: {
        // Measured along the track from where the gesture opened, so the knob
        // tracks the pointer instead of jumping to it. The track as it is
        // drawn — the pointer is in screen pixels, and the chrome is
        // counter-scaled so a scaled-down node still gets a usable one.
        const width = Math.max(opening.size.width * opening.values.scale * opening.outer.scale, 60);
        const travelled = (point.x - opening.origin.x) / (width > 0 ? width : 1);
        const settled = Math.min(1, Math.max(0, opening.values.opacity + travelled));
        return { ...opening.edit, opacity: opening.edit.opacity + (settled - opening.values.opacity) };
      }
    }
  };

  const doGesture = (clientX: number, clientY: number) => {
    const opening = start.current;
    if (!opening) return;

    const point = inContainerSpace(clientX, clientY);
    if (Math.abs(point.x - opening.origin.x) > 2 || Math.abs(point.y - opening.origin.y) > 2) {
      moved.current = true;
      dragged.current = true;
    }

    const next = editAt(point);
    setEdit(next);

    if (reportsProperties) {
      const authored = authoredValues(next);
      manager.sendMessageSelectedNodeProperties({
        positionX: authored.translate[0] * (inertiaCanvasSize?.width ?? 0),
        positionY: authored.translate[1] * (inertiaCanvasSize?.height ?? 0),
        sizeX: opening.size.width,
        sizeY: opening.size.height,
        values: authored,
      });
    }

    // The guides box a node in as it is moved. They mean nothing for a
    // rotation or an opacity, where the node stays where layout put it.
    if (tool !== InertiaTool.translate) return;

    // Boxed on screen, from the drag as the screen saw it: the edit this gesture
    // authored is measured inside whatever the node is drawn within, which is
    // not the space the guides are drawn in.
    const moveOnScreen = constrainToAxis(opening.axis, {
      x: point.x - opening.origin.x,
      y: point.y - opening.origin.y,
    });
    const scale = opening.values.scale * opening.outer.scale;
    guides?.show(
      {
        x: opening.center.x + moveOnScreen.x,
        y: opening.center.y + moveOnScreen.y,
      },
      { width: opening.size.width * scale, height: opening.size.height * scale }
    );
  };

  /// Ends a gesture and hands the result to the editor to be written into the
  /// schema. One message whatever the tool, carrying the whole transform: a
  /// keyframe holds all five values, so the four this gesture did not touch
  /// have to travel with the one it did.
  ///
  /// A press that never moved is a tap — the selection toggle's — and has
  /// nothing to author, so nothing is sent for it. Committing it anyway handed
  /// the editor a no-op transform on every tap, which the editor records as an
  /// edit: it writes a schema for a node that had none and hands the schemas
  /// straight back, and a fresh `auto` schema arriving is what starts a run. So
  /// tapping a node to unselect it played the animation. The other two runtimes
  /// already end the gesture this way — Compose commits only once its drag
  /// threshold is crossed, and SwiftUI's `DragGesture` never opens on a tap.
  const stopGesture = () => {
    if (start.current && dragged.current && inertiaCanvasSize) {
      commit(authoredValues(edit));
    }
    start.current = null;
    dragged.current = false;
    guides?.hide();
  };

  /// The switch is the editor's to flip and can go off mid-gesture, which the
  /// pointer capture would otherwise ride straight through. The gesture is
  /// dropped rather than committed — the editor has stopped taking edits — and
  /// the node goes back to what its schema puts it at, since the edit it was
  /// being dragged towards is never going to be sent.
  useEffect(() => {
    if (canEdit || !start.current) return;
    start.current = null;
    moved.current = false;
    dragged.current = false;
    guides?.hide();
    setEdit(noToolEdit);
  }, [canEdit]);

  /// Switching tools drops a gesture in progress too: it was opened against
  /// the old tool's handle, and the property it was editing is not the one the
  /// new tool would author.
  useEffect(() => {
    start.current = null;
    guides?.hide();
  }, [tool]);

  /// Only while the node is editable — an app running without an editor
  /// attached has no handles to size, and no reason to watch every actionable
  /// for resizes.
  useEffect(() => {
    const element = elementRef.current;
    if (!canEdit || !element) return;

    // `offsetWidth`/`offsetHeight` are the laid-out box, which no transform
    // touches — unlike the observer's own `contentRect`, which would report
    // the node mid-scale while a scale handle is being dragged.
    const measure = () => setLayoutBox({ width: element.offsetWidth, height: element.offsetHeight });
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, [canEdit, elementRef]);

  /// Which of the active tool's knobs this press landed on, if any. The handles
  /// are drawn deep inside the node, but the gesture is run from out here,
  /// where the pointer capture lives — so the press is routed by what it hit
  /// rather than by which element listens.
  const handleAt = (target: EventTarget | null): string | null =>
    target instanceof Element
      ? target.closest(`[${HANDLE_ATTRIBUTE}]`)?.getAttribute(HANDLE_ATTRIBUTE) ?? null
      : null;

  /// Everything the element taking the pointer capture has to listen for.
  /// Spread onto it, so the one that hears the press is the one that owns the
  /// gesture.
  const pointerHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      const handle = handleAt(e.target);
      const onHandle = handle !== null;
      if (!canDragBody && !onHandle) return;

      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      beginGesture(e.clientX, e.clientY, axisFromHandle(handle));
      // A press on a knob is never a click on the node. Without this,
      // grabbing a handle and letting go without moving would fall through
      // to the selection toggle and deselect the thing being edited.
      if (onHandle) moved.current = true;
    },
    onPointerMove: (e: React.PointerEvent) => {
      e.stopPropagation();
      doGesture(e.clientX, e.clientY);
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.stopPropagation();
      stopGesture();
    },
    // A gesture the browser takes away — a cancelled touch, a lost capture —
    // never reaches `onPointerUp`, and the grid would be left on screen.
    onPointerCancel: (e: React.PointerEvent) => {
      e.stopPropagation();
      stopGesture();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (moved.current) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };

  /// The chrome for the active tool, sized to this node's laid-out box.
  const toolHandles = canEdit ? (
    <InertiaToolHandles tool={tool} values={values} size={layoutBox} />
  ) : null;

  return { values, layoutBox, moved, canDragBody, pointerHandlers, toolHandles };
}

export function withDrag<T extends DraggableProps>(
  WrappedComponent: React.ComponentType<T & Partial<DraggableInjectedProps>>
) {
  return function Draggable(props: T & { edit: InertiaToolEdit; setEdit: React.Dispatch<React.SetStateAction<InertiaToolEdit>> }) {
    const { hierarchyId, isSelected, actionableIdPairs, edit, setEdit, initialValues, containerRef, handleClick, inertiaDataModel } = props;

    /// Selection alone is not enough. Turning the editor's switch off leaves
    /// `actionableIdPairs` as it was — the editor keeps the selection so it can
    /// be restored — so nodes selected beforehand stay `isSelected` and would
    /// go on dragging against an editor that has stopped taking edits. Same
    /// pair of conditions the Swift and Compose runtimes gate their gestures on.
    const canEdit = isSelected && (inertiaDataModel?.isActionable ?? false);
    const tool = inertiaDataModel?.activeTool ?? InertiaTool.translate;

    const inertiaCanvasSize = useContext(InertiaCanvasSizeContext);

    /// One `MessageEdit` whatever the tool, carrying the whole transform: a
    /// keyframe holds all five values, so the four this gesture did not touch
    /// have to travel with the one it did. Named for the whole selection, since
    /// an actionable is dragged as one of however many the editor has picked.
    const commit = (values: InertiaAnimationValuesBase) => {
      if (!actionableIdPairs || !inertiaCanvasSize) return;

      manager.sendMessageEdit({
        tool,
        values,
        actionableIds: Array.from(actionableIdPairs),
      });
    };

    const { moved, canDragBody, pointerHandlers, toolHandles } = useToolGesture({
      nodeId: hierarchyId,
      elementRef: containerRef,
      initialValues,
      canEdit,
      tool,
      edit,
      setEdit,
      commit,
      reportsProperties: true,
    });

    /// The click that ends a gesture is dispatched at whichever element held the
    /// pointer capture, not at the element under the cursor — so while a node is
    /// selected the click never reaches its content, which is exactly when
    /// unselecting has to work. The selection toggle lives here, on the element
    /// that takes the capture.
    const handleClickToSelect = () => {
      if (!moved.current) handleClick();
    };

    return (
      <div
        {...pointerHandlers}
        onClick={handleClickToSelect}
        style={{
          cursor: canDragBody ? "grab" : "default",
          touchAction: "none",
        }}
      >
        <WrappedComponent {...props} moved={moved} toolHandles={toolHandles} />
      </div>
    );
  };
}

// ------------------ InertiaGuts ------------------
// ------------------ Shape canvas (WebGL) ------------------

/// Positions arrive already normalized to the container the canvas fills, with
/// a top-left origin — the same space the Metal and GLES runtimes hand their
/// renderers — so the only work here is the flip into clip space.
const SHAPE_VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec4 a_color;
varying vec4 v_color;

void main() {
    v_color = a_color;
    gl_Position = vec4(a_position.x * 2.0 - 1.0, 1.0 - a_position.y * 2.0, 0.0, 1.0);
}
`;

/// Colours pass through unpremultiplied; the context is created to match, and
/// the blend function does the source-over.
const SHAPE_FRAGMENT_SHADER = `
precision mediump float;
varying vec4 v_color;

void main() {
    gl_FragColor = v_color;
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(`[INERTIA_LOG]: shape shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
        gl.deleteShader(shader);
        return null;
    }

    return shader;
}

function createShapeProgram(gl: WebGLRenderingContext): WebGLProgram | null {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, SHAPE_VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, SHAPE_FRAGMENT_SHADER);
    if (!vertex || !fragment) return null;

    const program = gl.createProgram();
    if (!program) return null;

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(`[INERTIA_LOG]: shape program failed to link: ${gl.getProgramInfoLog(program)}`);
        return null;
    }

    return program;
}

/// This node's size as laid out — the size the shapes behind it are measured
/// against, since they are multiples of it.
///
/// Read off `offsetWidth`/`offsetHeight` rather than `getBoundingClientRect`,
/// which reports what the browser painted: the animation writes a CSS transform
/// on this very element, and a rect measured through a rotation is the
/// *bounding box* of the rotated element — it swells and shrinks as the angle
/// turns. Measuring shapes from that made them pulse in step with the spin.
/// Offsets are layout, and layout is what the shapes are anchored to.
function layoutSizeOf(element: HTMLElement): InertiaCanvasSize {
    return { width: element.offsetWidth, height: element.offsetHeight };
}

/// These shapes as the canvases they are drawn on, back to front: the order
/// their z-indexes put them in, cut into runs wherever one of them has to be
/// drawn on a canvas of its own.
///
/// A shape drawn alone is a layer by itself; the shapes between two of those
/// share one canvas, the way every backdrop shape here used to. Cutting the run
/// at those points is what makes a z-index mean the same thing for a moving
/// shape as for a still one: canvases are elements, elements paint in the order
/// they are written, so an animated shape can sit *behind* a plain one rather
/// than always floating over the whole backdrop.
///
/// The same layering the Swift runtime builds in `InertiaShapesView.layers`.
function shapeLayers(
    shapes: Array<InertiaShape>,
    isDrawnAlone: (shape: InertiaShape) => boolean
): Array<Array<InertiaShape>> {
    const layers: Array<Array<InertiaShape>> = [];
    let isSharedRunOpen = false;

    stackedShapes(shapes).forEach(shape => {
        if (isDrawnAlone(shape)) {
            layers.push([shape]);
            isSharedRunOpen = false;
        } else if (isSharedRunOpen) {
            layers[layers.length - 1].push(shape);
        } else {
            layers.push([shape]);
            isSharedRunOpen = true;
        }
    });

    return layers;
}

/// The actionable's canvas: the shapes authored alongside its animation, drawn
/// in WebGL on whichever side of its content they asked for — see `position`.
///
/// Sized and placed by the box the shapes themselves occupy — `actionableSize`
/// is the view, and the shapes are multiples of it — so one reaching past the
/// view it belongs to grows the canvas instead of being cut at any edge. The
/// container is not in this: a canvas fitted to it stopped a shape at the
/// window. It sits inside the element the playback controller writes its
/// transform to, which is what carries the shapes along with the animation.
///
/// A canvas given an `animation` is one shape's own drawing rather than the
/// actionable's backdrop: it registers itself with the controller, which then
/// writes that track's transform onto this canvas element every frame — the
/// same way it moves an actionable, and stacked on top of the actionable's own
/// transform because this element sits inside it.
///
/// A canvas the editor has selected is registered whether or not it was given a
/// track, since a gesture on it has to move it before there is any track to move
/// it by — see `InertiaPlaybackController.registerShapeNode`.
const InertiaShapeCanvas: React.FC<{
    shapes: Array<InertiaShape>;
    actionableSize: InertiaCanvasSize;
    /// Which side of the actionable's content this canvas is drawn on, which is
    /// the side its shapes asked for — see `InertiaShapePosition`. All of them
    /// share it: the shapes are grouped by position before a canvas is made for
    /// any of them.
    position?: InertiaShapePosition;
    animation?: InertiaAnimationSchema;
    nodeId?: string;
    hierarchyIdPrefix?: string;
    /// The instance this canvas is drawn inside of, whose transform the shape's
    /// own is stacked on top of. What a selected shape's gestures are measured
    /// against — see `ToolGestureOptions.outer`.
    actionableId?: string;
    /// The one shape on this canvas, when the editor has picked it. Selection
    /// is what gives a shape a canvas to itself, so there is never more than
    /// one — see `InertiaGuts`.
    selected?: InertiaShape;
    /// Whether this canvas stays off screen until the animation is on it — the
    /// one shape on it appears with the run rather than backing it, see
    /// `InertiaShape.showsBeforeAnimation`. Another reason to register with the
    /// controller: what is drawn is then a decision taken per frame.
    hidesBeforeAnimation?: boolean;
    /// Picks the shape a click landed on up, or puts it down again. Absent
    /// outside the editor, which is what leaves a shape the pure backdrop it is
    /// in a shipped build.
    onPick?: (shape: InertiaShape) => void;
}> = ({ shapes, actionableSize, position = InertiaShapePosition.bottom, animation, nodeId, hierarchyIdPrefix, actionableId, selected, hidesBeforeAnimation, onPick }) => {
    /// What the controller writes the transform to, and what the chrome is
    /// placed inside: the canvas cannot hold the border and the handles, since a
    /// `<canvas>` has no children.
    const boxRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const glRef = useRef<{ gl: WebGLRenderingContext; program: WebGLProgram; buffer: WebGLBuffer } | null>(null);
    const controller = useContext(InertiaPlaybackContext);

    // A layout effect rather than a passive one, because registering is also
    // what takes a shape that waits for the animation *off* screen: run after
    // the browser has painted, the first frame of it would be the one frame it
    // is not supposed to be seen in.
    React.useLayoutEffect(() => {
        const box = boxRef.current;
        if (!box || !controller || !nodeId || !hierarchyIdPrefix) {
            return;
        }
        if (!animation && !selected && !hidesBeforeAnimation) {
            return;
        }

        controller.registerShapeNode(nodeId, hierarchyIdPrefix, box, animation, hidesBeforeAnimation);

        return () => controller.unregisterNode(nodeId);
    }, [controller, animation, nodeId, hierarchyIdPrefix, !!selected, hidesBeforeAnimation]);

    /// The canvas's own box, in multiples of the actionable.
    const bounds = useMemo(() => shapeBounds(shapes), [shapes]);

    /// Every shape restated in the canvas's 0..1 space and flattened into the
    /// one triangle list the GPU draws: x, y, r, g, b, a per vertex.
    ///
    /// Independent of the actionable's size: resizing the view resizes the
    /// canvas element without rebuilding a vertex of it.
    const vertexData = useMemo(() => {
        const data: number[] = [];
        if (!bounds) return new Float32Array(data);

        shapes.forEach(shape => {
            normalizedShapeTriangles(shape, bounds).forEach((vertex: Vertex) => {
                data.push(
                    vertex.position.x,
                    vertex.position.y,
                    vertex.color.red,
                    vertex.color.green,
                    vertex.color.blue,
                    vertex.color.alpha
                );
            });
        });

        return new Float32Array(data);
    }, [shapes, bounds]);

    /// The length a shape's coordinates are multiples of, across and down alike:
    /// the shorter side of the actionable's box.
    ///
    /// One length rather than two is what keeps a described vector the shape it
    /// was described as. Scaling x by the element's width and y by its height
    /// puts a shape in a square space that is then stretched to fit the element,
    /// so a circle of size 1 came out an oval on every element that was not
    /// itself square, and the taller or wider the element the further from round
    /// it got. Measured against one side, a circle is round, a square is square,
    /// and a shape keeps its proportions at every size that element takes.
    ///
    /// The shorter side rather than the longer one, so a shape authored at 1
    /// still fits inside the element it backs in both directions. The same unit
    /// the Swift and Kotlin runtimes measure with — see `InertiaShapesView.unit`.
    const unit = Math.min(actionableSize.width, actionableSize.height);

    /// The canvas element's box in CSS pixels, relative to the actionable's
    /// top-left corner — which is what an absolutely positioned child is offset
    /// from, and not where a shape's coordinates are measured from.
    ///
    /// The origin a shape is drawn about is the *middle* of the actionable, so a
    /// shape half the size of the element it backs sits in the middle of it
    /// rather than hanging off a corner. Half the element is the step between the
    /// two, and it is what the Swift runtime gets for free by centring its ZStack
    /// — see `InertiaShapesView.body`.
    const box = useMemo(() => bounds && {
        left: actionableSize.width / 2 + bounds.x * unit,
        top: actionableSize.height / 2 + bounds.y * unit,
        width: bounds.width * unit,
        height: bounds.height * unit
    // Both sides of the element, not just `unit`: the half-view step moves when
    // the longer side changes, which is a resize `unit` alone does not see.
    }, [bounds, unit, actionableSize.width, actionableSize.height]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !box) return;

        if (!glRef.current) {
            // Unpremultiplied to match the blend function below, which is the
            // source-over every other runtime draws with.
            const gl = canvas.getContext("webgl", {
                alpha: true,
                premultipliedAlpha: false,
                antialias: true
            });
            if (!gl) {
                console.error("[INERTIA_LOG]: WebGL is unavailable; shapes will not be drawn");
                return;
            }

            const program = createShapeProgram(gl);
            const buffer = gl.createBuffer();
            if (!program || !buffer) return;

            glRef.current = { gl, program, buffer };
        }

        const { gl, program, buffer } = glRef.current;

        // The backing store is in device pixels; the element is sized in CSS
        // pixels by the style below.
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(box.width * ratio));
        canvas.height = Math.max(1, Math.round(box.height * ratio));

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // An emptied shape list still clears, which is what takes the last
        // frame's shapes back off the screen.
        if (vertexData.length === 0) return;

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.DYNAMIC_DRAW);

        const stride = 6 * Float32Array.BYTES_PER_ELEMENT;

        const positionLocation = gl.getAttribLocation(program, "a_position");
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, stride, 0);

        const colorLocation = gl.getAttribLocation(program, "a_color");
        gl.enableVertexAttribArray(colorLocation);
        gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

        gl.drawArrays(gl.TRIANGLES, 0, vertexData.length / 6);
    }, [vertexData, box]);

    /// The clip that keeps a press on this canvas to the artwork, so a shape can
    /// be picked by clicking it rather than only by finding its row in the
    /// editor's hierarchy.
    ///
    /// A canvas is fitted to the box its shapes occupy together, and that box is
    /// mostly not shape. Clipped to the drawing, the corner beside a circle and
    /// the hole through an unfilled ring go on reaching the app's own content
    /// underneath exactly as they did before any of this existed — `clip-path`
    /// bounds what the browser will deliver a press to, not just what paints.
    ///
    /// Absent outside the editor, where there is nothing to pick.
    const clipPath = useMemo(() => {
        if (!onPick || !bounds || !box) return undefined;

        const triangles = shapes.flatMap(shape => normalizedShapeTriangles(shape, bounds));
        const path = shapeClipPath(triangles, box.width, box.height);

        return path ? `path("${path}")` : undefined;
    }, [onPick, shapes, bounds, box]);

    // Shapes enclosing no area have no canvas, which is also the state in which
    // there is nothing to draw.
    if (!box) return null;

    return (
        <div
            ref={boxRef}
            style={{
                position: "absolute",
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                // A selected shape is dragged by its own box, so that box has to
                // be able to hear a press. Everything else here is backdrop, and
                // would otherwise swallow taps meant for the views it overlaps.
                pointerEvents: selected ? "auto" : "none",
                // Being first in the DOM is not enough to paint first: a
                // positioned element paints above its in-flow siblings whatever
                // order they are written in, so the canvas was drawing *over*
                // the card — which reads as the shape blending through it.
                // Negative z-index drops it below the in-flow content while
                // staying above the actionable's own background, which is what
                // a backdrop is. It relies on the actionable isolating itself;
                // see the wrapper below. The selection chrome is inside this, so
                // it stays behind the app's own content too — a shape is drawn
                // behind the views, and it is picked in the hierarchy panel
                // rather than out here.
                //
                // A shape asking for the other side wants exactly what the
                // negative index was undoing, so it is simply not applied:
                // painted in with the positioned siblings, in the DOM order the
                // actionable writes its canvases in, which is over the content
                // and under the chrome that follows it there.
                zIndex: position === InertiaShapePosition.top ? 0 : -1
            }}
        >
            <canvas
                ref={canvasRef}
                style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: box.width,
                    height: box.height,
                    pointerEvents: "none"
                }}
            />

            {clipPath && bounds && (
                <div
                    onClick={(event) => {
                        // A click on a vector belongs to the vector. Without
                        // stopping here it would go on to the wrapper the
                        // actionable's own selection toggle listens on, and one
                        // click would pick the shape and the view behind it.
                        event.stopPropagation();

                        // In the element's own coordinates, which is what
                        // `offsetX` reports — measured through whatever
                        // transform the actionable and this canvas are drawn
                        // under, so the point needs no unwinding here.
                        const unit = Math.min(actionableSize.width, actionableSize.height);
                        if (!(unit > 0)) return;

                        const shape = hitTestShapes(shapes, {
                            x: bounds.x + event.nativeEvent.offsetX / unit,
                            y: bounds.y + event.nativeEvent.offsetY / unit
                        });

                        if (shape) onPick?.(shape);
                    }}
                    style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        width: box.width,
                        height: box.height,
                        // Set here rather than inherited: the box around this is
                        // backdrop and takes no presses, and a descendant asking
                        // for them is how one part of it opts back in.
                        pointerEvents: "auto",
                        cursor: "pointer",
                        clipPath
                    }}
                />
            )}

            {selected && nodeId && hierarchyIdPrefix && (
                <InertiaShapeChrome
                    shape={selected}
                    nodeId={nodeId}
                    hierarchyIdPrefix={hierarchyIdPrefix}
                    actionableId={actionableId}
                    boxRef={boxRef}
                    onPick={onPick}
                />
            )}
        </div>
    );
};

/// The border and handles a selected shape grows, and the gesture that drags it.
///
/// The same chrome an actionable shows and the same tools, because a shape is
/// edited exactly as a view is: one palette, one gesture, one `MessageEdit`.
/// What differs is only what the edit names — the shape's own id under the
/// schema that carries it, which is exactly how it was selected — and what it is
/// measured from, which is the track the shape carries rather than the
/// actionable's.
///
/// None of the outer geometry the Swift runtime needs applies here. The box this
/// sits in is measured with `getBoundingClientRect`, which reports what the
/// browser painted — the actionable's transform and the shape's own already
/// composed — so the gesture math has nothing left to unwind.
const InertiaShapeChrome: React.FC<{
    shape: InertiaShape;
    /// What the playback controller knows this shape's canvas as.
    nodeId: string;
    /// The actionable carrying the schema this shape was authored in, which is
    /// the prefix half of the pair an edit names it by.
    hierarchyIdPrefix: string;
    /// The instance this shape is drawn inside of.
    actionableId?: string;
    boxRef: React.RefObject<HTMLDivElement>;
    /// Puts this shape back down. The chrome covers the shape it belongs to and
    /// sits above the layer a click would otherwise be picked off, so without
    /// this there is no way to unpick a shape by clicking it.
    onPick?: (shape: InertiaShape) => void;
}> = ({ shape, nodeId, hierarchyIdPrefix, actionableId, boxRef, onPick }) => {
    const { inertiaDataModel } = useContext(InertiaContext)!;
    const inertiaCanvasSize = useContext(InertiaCanvasSizeContext);
    const controller = useContext(InertiaPlaybackContext);

    const tool = inertiaDataModel?.activeTool ?? InertiaTool.translate;

    /// Everything this shape's gestures have added on top of its track, still
    /// waiting for the editor to fold them in.
    const [edit, setEdit] = useState<InertiaToolEdit>(noToolEdit);

    /// The values the shape's own track starts it at. A shape authored as
    /// backdrop has no track and so starts at the identity, which is where the
    /// editor writes the first edit on it from.
    const initialValues = shape.animation?.initialValues;

    /// Dropped once the editor has written the gesture into the shape's track
    /// and sent it back, for the reason the actionables drop theirs: by then the
    /// move is in the schema, and leaving the edit in place would count it
    /// twice.
    useEffect(() => {
        setEdit(noToolEdit);
    }, [
        initialValues?.translate?.[0],
        initialValues?.translate?.[1],
        initialValues?.rotate,
        initialValues?.rotateCenter,
        initialValues?.scale,
        initialValues?.opacity,
    ]);

    /// The same `MessageEdit` an actionable sends, naming this shape alone: the
    /// editor resolves the pair against the schemas it holds, so an id naming a
    /// shape lands on that shape's own track — and creates one if it had none.
    const commit = (values: InertiaAnimationValuesBase) => {
        if (!inertiaCanvasSize) return;

        manager.sendMessageEdit({
            tool,
            values,
            actionableIds: [{ hierarchyIdPrefix, hierarchyId: shape.id }],
        });
    };

    const { layoutBox, moved, canDragBody, pointerHandlers, toolHandles } = useToolGesture({
        nodeId,
        elementRef: boxRef,
        initialValues,
        /// The actionable's transform as it is drawn right now: this shape's
        /// canvas sits inside the element carrying it, so a gesture out here is
        /// measured through it and an offset authored in here lands under it.
        outer: actionableId && controller ? controller.valuesFor(actionableId) : identityValues,
        // Reaching here at all means the editor has this shape selected and the
        // viewport is in actionable mode: nothing renders this chrome otherwise.
        canEdit: true,
        tool,
        edit,
        setEdit,
        commit,
    });

    return (
        <div
            {...pointerHandlers}
            // A press on a shape belongs to the shape. Without stopping here it
            // would go on to the wrapper the actionable's own drag listens on,
            // and one gesture would move both.
            //
            // A click that never moved is a tap, and a tap on the shape being
            // worked on puts it down — the same reading `handleClickToSelect`
            // makes of a click on an actionable's body. Dragging the shape by
            // this same box therefore does not unpick it.
            onClick={(e) => {
                e.stopPropagation();
                if (!moved.current) onPick?.(shape);
            }}
            style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: layoutBox.width || "100%",
                height: layoutBox.height || "100%",
                border: `2px solid ${HANDLE_COLOR}`,
                cursor: canDragBody ? "grab" : "default",
                touchAction: "none",
                boxSizing: "border-box",
            }}
        >
            {toolHandles}
        </div>
    );
};

const InertiaGuts: React.FC<DraggableProps> = React.memo(
  ({ hierarchyId, hierarchyIdPrefix, isSelected, containerRef, children, inertiaDataModel, toolHandles }) => {
    const controller = useContext(InertiaPlaybackContext);
    const setInertiaDataModel = useContext(InertiaContext)?.setInertiaDataModel;
    const inertiaContainerId = useContext(InertiaContainerIdContext);

    // The controller writes this element's transform every frame it draws, so
    // registration is all there is to animating it.
    useEffect(() => {
      const element = containerRef.current;
      if (!element || !controller || !hierarchyId || !hierarchyIdPrefix) {
        return;
      }

      console.log(`[INERTIA_LOG]: [InertiaGuts] registering hierarchyId: ${hierarchyId}, hierarchyIdPrefix: ${hierarchyIdPrefix}`);
      controller.registerNode(hierarchyId, hierarchyIdPrefix, element);

      return () => {
        controller.unregisterNode(hierarchyId);
      };
    }, [controller, containerRef, hierarchyId, hierarchyIdPrefix]);

    /// The shapes authored against this actionable, if it has any. Read off the
    /// schema rather than the running animation, so the backdrop is there
    /// whether or not the animation is playing.
    ///
    /// Keyed on the maps rather than the model, like the container's own lookup:
    /// a new list here rebuilds every vertex buffer and repaints the canvases,
    /// and the model's identity changes on every selection.
    const shapes = useMemo(() => {
      if (!hierarchyIdPrefix || !inertiaDataModel) return [];

      const animationId = inertiaDataModel.actionableIdToAnimationIdMap?.get(hierarchyIdPrefix) ?? hierarchyIdPrefix;
      return inertiaDataModel.inertiaSchemas?.get(animationId)?.shapes ?? [];
    }, [inertiaDataModel?.actionableIdToAnimationIdMap, inertiaDataModel?.inertiaSchemas, hierarchyIdPrefix]);

    /// Remeasured whenever this node is resized. Layout is the only thing that
    /// resizes this box — the animation writes a transform, which `layoutSizeOf`
    /// deliberately does not see.
    const [layoutSize, setLayoutSize] = useState<InertiaCanvasSize>({ width: 0, height: 0 });

    useEffect(() => {
      const element = containerRef.current;
      if (!element || shapes.length === 0) return;

      const measure = () => setLayoutSize(layoutSizeOf(element));
      measure();

      const observer = new ResizeObserver(measure);
      observer.observe(element);

      return () => observer.disconnect();
    }, [containerRef, shapes]);

    const hasCanvas = shapes.length > 0
      && layoutSize.width > 0
      && layoutSize.height > 0;

    /// Tells the editor how big this actionable was laid out, so a shape
    /// authored against it can be drawn to size in a window with no copy of
    /// this app to measure — see `MessageNodeMeasured`.
    ///
    /// Only nodes carrying shapes are measured at all, which is also the only
    /// selection the editor can ask this question about. Sent again whenever an
    /// editor attaches: layout happened long before it was listening, and will
    /// not happen again just because it turned up.
    useEffect(() => {
      if (!hierarchyId || !hierarchyIdPrefix) return;
      if (layoutSize.width <= 0 || layoutSize.height <= 0) return;

      const report = () => manager.sendMessageNodeMeasured({
        hierarchyIdPrefix,
        hierarchyId,
        sizeX: layoutSize.width,
        sizeY: layoutSize.height,
      });

      report();
      return manager.addConnectedListener(report);
    }, [hierarchyId, hierarchyIdPrefix, layoutSize.width, layoutSize.height]);

    /// Whether the editor has picked a shape, by the shape's own id — the same
    /// selection the actionables are picked out of, since a shape travels as an
    /// `ActionableIdPair` like anything else. Which of the two an id names is
    /// not on the wire: both ends hold the schemas and resolve it by looking.
    const selectedShapeIds = useMemo(() => {
      if (!inertiaDataModel?.isActionable) return new Set<string>();
      return new Set(Array.from(inertiaSelection(inertiaDataModel, inertiaContainerId)).map(pair => pair.hierarchyId));
    }, [inertiaDataModel?.isActionable, inertiaDataModel?.actionableIdPairsByContainer, inertiaContainerId]);

    /// Whether a shape is drawn on a canvas of its own rather than sharing the
    /// backdrop.
    ///
    /// A track is one reason — it has to be able to move without dragging every
    /// other shape with it — and being selected is the other: the border and the
    /// handles are fitted to one shape's box, and a shape sharing a canvas has
    /// no box of its own to fit them to. The same split the Swift runtime makes
    /// in `isDrawnAlone`.
    ///
    /// Appearing with the animation is a third: what a canvas can be taken off
    /// screen by is `visibility`, which hides everything drawn on it, so a shape
    /// that is not on screen the whole time cannot share one with shapes that
    /// are. The Swift and Compose runtimes drop such a shape from the list they
    /// layer instead — this one keeps the element and hides it, because the
    /// vertex buffer behind it is a WebGL context that would otherwise be rebuilt
    /// every time the run came round.
    const isDrawnAlone = useCallback(
      (shape: InertiaShape) =>
        !!shape.animation
          || !!shape.ownCanvas
          || shape.showsBeforeAnimation === false
          || selectedShapeIds.has(shape.id),
      [selectedShapeIds]
    );

    /// The canvases drawn behind this actionable's content, and the ones drawn
    /// over it — the two sides a shape's `position` picks between, each cut into
    /// layers by `shapeLayers`.
    ///
    /// Split before either is layered, because the sides are separate stacks: a
    /// z-index orders the shapes on one side of the content, and no number puts
    /// a backdrop in front of the view it backs.
    const bottomLayers = useMemo(
      () => shapeLayers(shapes.filter(shape => (shape.position ?? InertiaShapePosition.bottom) !== InertiaShapePosition.top), isDrawnAlone),
      [shapes, isDrawnAlone]
    );
    const topLayers = useMemo(
      () => shapeLayers(shapes.filter(shape => shape.position === InertiaShapePosition.top), isDrawnAlone),
      [shapes, isDrawnAlone]
    );

    /// Picks a shape up, or puts it down again: the toggle a click on the
    /// artwork runs, which is the same one a click on this node's own body runs
    /// — see `handleClick` — and writes to the same selection.
    ///
    /// A shape travels as an `ActionableIdPair` like anything else: its own id
    /// under the schema that carries it, which is how the editor's hierarchy
    /// names it too, so picking a shape out here lights up the same row.
    ///
    /// The whole selection goes back on the wire rather than the one shape that
    /// changed, because that is what a `MessageActionables` says: not what was
    /// picked, but what *is* picked.
    ///
    /// Undefined outside actionable mode, which is what leaves the canvases
    /// taking no clicks at all in a shipped build.
    const pickShape = useMemo(() => {
      if (!hierarchyIdPrefix || !setInertiaDataModel || !inertiaContainerId || !inertiaDataModel?.isActionable) {
        return undefined;
      }

      return (shape: InertiaShape) => setInertiaDataModel(prev => {
        const current = inertiaSelection(prev, inertiaContainerId);
        const exists = Array.from(current).some(pair => pair.hierarchyId === shape.id);

        const next = exists
          ? new Set(Array.from(current).filter(pair => pair.hierarchyId !== shape.id))
          : new Set([...Array.from(current), { hierarchyIdPrefix, hierarchyId: shape.id }]);

        // This container's own tree and its own selection, never the app's: the
        // two halves of a `MessageActionables` are read together, and the editor
        // files what it is told under the tree that came with it.
        const tree = inertiaTree(prev, inertiaContainerId);
        if (tree) {
          manager.sendMessageActionables({
            tree,
            actionableIds: Array.from(next),
          });
        }

        return {
          ...prev,
          actionableIdPairsByContainer: inertiaSelectionReplacing(prev, inertiaContainerId, next),
        };
      });
    }, [hierarchyIdPrefix, setInertiaDataModel, inertiaContainerId, inertiaDataModel?.isActionable]);

    /// One layer as a canvas: a shape drawn alone carries its own track and the
    /// editor's selection, and a shared run is the backdrop every shape here
    /// used to be part of.
    ///
    /// Named after the first shape in the layer, which is a name no other layer
    /// can take — a shape belongs to exactly one — and one that survives the
    /// shape beside it being deleted. Instance-scoped, because two instances of
    /// a card need two canvases.
    const canvasForLayer = (layer: Array<InertiaShape>, position: InertiaShapePosition) => {
      const alone = layer.length === 1 && isDrawnAlone(layer[0]) ? layer[0] : undefined;
      // The shape being worked on stays drawn whatever it says: selection
      // happens in the editor's hierarchy, but everything done to a shape after
      // that is done to the thing on screen — dragged by its own box, sized by
      // its handles — and one that vanished until the timeline was rolling could
      // not be authored at all.
      const isSelected = !!alone && selectedShapeIds.has(alone.id);

      return (
        <InertiaShapeCanvas
          key={`${hierarchyId}--${layer[0].id}`}
          shapes={layer}
          actionableSize={layoutSize}
          position={position}
          animation={alone?.animation}
          nodeId={alone && hierarchyId ? `${hierarchyId}--${alone.id}` : undefined}
          hierarchyIdPrefix={alone ? hierarchyIdPrefix : undefined}
          actionableId={alone ? hierarchyId : undefined}
          selected={isSelected ? alone : undefined}
          hidesBeforeAnimation={!!alone && alone.showsBeforeAnimation === false && !isSelected}
          onPick={pickShape}
        />
      );
    };

    return (
      <div
        data-inertia-id={hierarchyId}
        ref={containerRef}
        style={{
          display: "inline-block",
          cursor: inertiaDataModel?.isActionable ? "pointer" : "default",
          position: "relative",
          pointerEvents: inertiaDataModel?.isActionable ? "auto" : "none",
          // Keeps the canvas's negative z-index inside this actionable. Without
          // a stacking context of its own the canvas would sink past this
          // element entirely and end up behind whatever the container paints —
          // and only while the animation happened to be writing a transform,
          // which forms one as a side effect, so it would come and go with
          // playback.
          isolation: "isolate",
        }}
      >
        {/* Painted behind the content by each canvas's own z-index, and back to
            front among themselves by the order they are written here. */}
        {hasCanvas && bottomLayers.map(layer => canvasForLayer(layer, InertiaShapePosition.bottom))}

        <div
          style={{
            pointerEvents: inertiaDataModel?.isActionable ? "none" : "auto",
          }}
        >
          {children}
        </div>

        {/* The same canvases on the other side of the content, for the shapes
            authored to sit over the view rather than behind it. After the
            content in the DOM, which is what paints them over it — the two
            differ in nothing else. */}
        {hasCanvas && topLayers.map(layer => canvasForLayer(layer, InertiaShapePosition.top))}

        {isSelected && inertiaDataModel?.isActionable && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              border: "3px solid rgb(85, 89, 220)",
              borderRadius: 8,
              pointerEvents: "none",
            }}
          />
        )}

        {/* Over the selection border, so a knob sitting on the edge is the thing
            that gets grabbed. Inside this element, so the transform the
            controller writes carries the chrome with the node. */}
        {toolHandles}
      </div>
    );
  }
);


export const DraggableInertiaGuts = React.memo(withDrag(InertiaGuts));

// ------------------ Inertia ------------------
export const Inertia: React.FC<InertiaProps> = ({ children, id }) => {
  /// The id the app authored against, which every instance of this actionable
  /// shares. What playback is keyed by, and what a schema loaded from a project
  /// file is named after.
  const hierarchyIdPrefix = id;
  const { inertiaDataModel, setInertiaDataModel } = useContext(InertiaContext)!;
  const inertiaParentId = useContext(InertiaParentIdContext)!;
  const inertiaIsContainer = useContext(InertiaIsContainerContext)!;
  const inertiaContainerId = useContext(InertiaContainerIdContext);
  const indexManager = SharedIndexManager.shared;
  const containerRef = useRef<HTMLDivElement>(null);

  const [edit, setEdit] = useState<InertiaToolEdit>(noToolEdit);
  /// This instance's own id: the authored id plus its index among its siblings.
  const [instanceId, setInstanceId] = useState<string>();

  /// Held for as long as this node is mounted in this container, and handed back
  /// when it is not.
  ///
  /// The index used to be claimed once and kept in a ref so a remount would not
  /// take a second one — which a ref cannot do, because an unmount throws the
  /// ref away with the rest of the component. Nothing was holding a name still;
  /// the counter simply climbed, and a tab that had been away came back under
  /// ids the editor had never been told about.
  ///
  /// Releasing is what keeps the name still instead: the index goes back to the
  /// container it was taken from, and the next view of this prefix to mount
  /// there — which, on a tab switched back to, is this same view — takes it
  /// again. React runs every cleanup in a commit before any of that commit's
  /// effects, so the tab being left has given its indices back before the tab
  /// being opened asks for one.
  useEffect(() => {
    const claimedId = indexManager.claimId(inertiaContainerId, hierarchyIdPrefix);
    setInstanceId(claimedId);

    return () => {
      indexManager.releaseId(inertiaContainerId, hierarchyIdPrefix, claimedId);
    };
  }, [indexManager, hierarchyIdPrefix, inertiaContainerId]);

  /// This node's place in its container's hierarchy, for as long as it is in it.
  ///
  /// Taken out again on the way off screen: this runtime unmounts a view that is
  /// not on the selected tab rather than keeping it alive, so a hierarchy that
  /// only ever grew described an app that no longer existed — see
  /// `Tree.removeNode`.
  ///
  /// Keyed on the map of hierarchies rather than on the model holding it: the
  /// model is replaced on every write, and an effect that tore this down and
  /// rebuilt it whenever anything else changed would take the node out of the
  /// tree and put it back on every selection.
  const trees = inertiaDataModel?.trees;

  useEffect(() => {
    if (!instanceId || !trees || !inertiaContainerId) return;

    // Into this container's own hierarchy — see `InertiaDataModel.trees`.
    const tree = treeFor(trees, inertiaContainerId);
    tree.addRelationship(instanceId, inertiaParentId, inertiaIsContainer);

    return () => {
      tree.removeNode(instanceId);
    };
  }, [instanceId, inertiaParentId, inertiaIsContainer, inertiaContainerId, trees]);

  /// The values the schema starts this actionable at. The playback controller
  /// writes them as the node's own transform, so the edit that sits on top of
  /// them goes back to nothing whenever they change: by then the gesture has
  /// been authored into the schema, and leaving it in place would count the same
  /// move twice. It is also what returns a node to the origin when the editor
  /// resets an animation's initial values.
  ///
  /// Resolved by prefix, the way the controller resolves the schema it draws.
  const initialValues = useMemo(() => {
    if (!inertiaDataModel) return null;

    const animationId = inertiaDataModel.actionableIdToAnimationIdMap?.get(hierarchyIdPrefix) ?? hierarchyIdPrefix;
    return inertiaDataModel.inertiaSchemas?.get(animationId)?.initialValues ?? null;
  }, [inertiaDataModel, hierarchyIdPrefix]);

  /// Keyed on the values themselves rather than on the data model: any other
  /// update — a selection, say — would otherwise drop a gesture the editor has
  /// not been told about yet, snapping the node out from under the cursor.
  useEffect(() => {
    setEdit(noToolEdit);
  }, [
    initialValues?.translate?.[0],
    initialValues?.translate?.[1],
    initialValues?.rotate,
    initialValues?.rotateCenter,
    initialValues?.scale,
    initialValues?.opacity,
  ])

  const isSelected = instanceId
    ? Array.from(inertiaSelection(inertiaDataModel, inertiaContainerId)).some(pair => pair.hierarchyId === instanceId)
    : false;

  const handleClick = () => {
  if (!instanceId || !hierarchyIdPrefix || !inertiaContainerId || !inertiaDataModel?.isActionable) return;

  const pair: ActionableIdPair = { hierarchyIdPrefix, hierarchyId: instanceId };

  setInertiaDataModel(prev => {
    const currentPairs = inertiaSelection(prev, inertiaContainerId);
    const exists = Array.from(currentPairs).some(p => p.hierarchyId === instanceId);

    const newPairs = exists
      ? new Set(Array.from(currentPairs).filter(p => p.hierarchyId !== instanceId))
      : new Set([...Array.from(currentPairs), pair]);

    // This container's own tree and its own selection — see `pickShape`.
    const tree = inertiaTree(prev, inertiaContainerId);
    if (tree) {
      manager.sendMessageActionables({
        tree,
        actionableIds: Array.from(newPairs),
      });
    }

    return {
      ...prev,
      actionableIdPairsByContainer: inertiaSelectionReplacing(prev, inertiaContainerId, newPairs),
    };
  });
};


  return (
    <DraggableInertiaGuts
      key={instanceId}
      hierarchyId={instanceId}
      hierarchyIdPrefix={hierarchyIdPrefix}
      handleClick={handleClick}
      isSelected={isSelected}
      containerRef={containerRef}
      children={children}
      inertiaDataModel={inertiaDataModel}
      actionableIdPairs={inertiaSelection(inertiaDataModel, inertiaContainerId)}
      edit={edit}
      setEdit={setEdit}
      initialValues={initialValues ?? undefined}
    />
  );
};
