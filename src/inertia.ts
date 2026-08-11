import {Vertex} from 'inertia-base'

/// libinertia, as this runtime uses it: the wasm module, and enough of a facade
/// over its C exports that nothing above has to think about the heap.
///
/// The library is what draws every shape canvas — see `InertiaShapeCanvas`. The
/// same library draws them in the Swift and Compose runtimes, through the same C
/// entry points; what differs is only how a host hands over a pointer, which
/// here means a wasm heap offset.

/// Bytes one vertex occupies in the wasm heap, and where each field sits inside
/// it.
///
/// This mirrors `InertiaVertex` in inertia_vertex.h — two float64 for the
/// position, four float32 for the colour — and there is nothing in the build that
/// checks the two still agree, so the library exports its own `sizeof` and
/// `loadInertia` checks this against it. A drift does not fail to compile: it
/// draws garbled geometry, or reads past the end of the array.
export const VERTEX_BYTES = 32

/// The emscripten module, as much of it as this runtime touches.
type InertiaModule = {
    cwrap: (name: string, returns: string | null, args: Array<string>) => (...params: Array<number>) => number
    ccall: (name: string, returns: string | null, args: Array<string>, params: Array<unknown>) => number
    stringToNewUTF8: (value: string) => number
    _malloc: (bytes: number) => number
    _free: (ptr: number) => void
    HEAPU8: Uint8Array
}

/// A renderer handle, which is a wasm pointer and so a plain number on this
/// side. Distinct from the vertex pointers below only by name, which is the
/// most a JS host can do to keep the two apart.
export type InertiaRendererHandle = number

export type InertiaLibrary = {
    /// Build a renderer on the canvas `selector` names, or null when there is no
    /// such element or no WebGL2 to be had from it. One per canvas: the library
    /// makes each renderer's context current before it touches GL, so a page may
    /// hold as many as it has canvases.
    createRenderer: (selector: string) => InertiaRendererHandle | null

    /// Tears a renderer down, releasing its GL objects and its context. Browsers
    /// cap how many contexts a page may hold, so a canvas that unmounts has to
    /// hand its own back.
    destroyRenderer: (renderer: InertiaRendererHandle) => void

    /// Point the renderer at `count` vertices at `ptr`. Nothing is copied: the
    /// library re-reads that memory every frame, so animating a shape is a write
    /// through `writeVertices` and no call at all.
    ///
    /// The pointer must stay allocated, and stay `count` long, until this is
    /// called again or the renderer is destroyed. Passing 0 detaches.
    setVertices: (renderer: InertiaRendererHandle, ptr: number, count: number) => void

    /// The canvas' backing store changed size, in device pixels. The canvas is
    /// this side's, so it is this side that reports it.
    resize: (renderer: InertiaRendererHandle, width: number, height: number) => void

    /// Clear and draw one frame. No present call: the browser composites the
    /// canvas when the task that drove this returns.
    draw: (renderer: InertiaRendererHandle) => void

    /// Allocate room for `count` vertices in the wasm heap, or 0 if the heap
    /// could not grow. The caller owns the pointer and must hand it back to
    /// `free` — after the renderer holding it is destroyed, never before.
    allocVertices: (count: number) => number
    free: (ptr: number) => void

    /// Write vertices into the heap at `ptr`, which must have room for
    /// `vertices.length` of them.
    ///
    /// A DataView rather than typed arrays because the struct is mixed width:
    /// float64 positions followed by float32 colours means no single view spans a
    /// vertex, and a Float64Array over the colours would read two channels as
    /// one number. Little-endian is hardcoded because wasm always is.
    ///
    /// Rebuilt on every call rather than cached: the module is built with
    /// ALLOW_MEMORY_GROWTH, which swaps the underlying ArrayBuffer out and
    /// detaches every existing view.
    writeVertices: (ptr: number, vertices: Array<Vertex>) => void
}

/// The module, instantiated once per page rather than once per canvas: each call
/// to the emscripten factory builds a fresh heap and a fresh copy of the
/// library, and every canvas on a page can share one.
///
/// Started on the first canvas that asks rather than at import time, so a page
/// that never draws a shape never fetches the wasm.
let pending: Promise<InertiaLibrary> | null = null

export function loadInertia(): Promise<InertiaLibrary> {
    if (!pending) {
        pending = instantiate()
    }

    return pending
}

async function instantiate(): Promise<InertiaLibrary> {
    // A static specifier, so a consumer's bundler can trace it and emit
    // inertia.wasm as an asset of its own — the glue locates the binary with
    // `new URL("inertia.wasm", import.meta.url)`, which webpack and vite both
    // understand. Ignored by the type checker because this file is generated
    // output with no declarations shipped beside it.
    // @ts-ignore
    const createInertia = (await import('./wasm/inertia.mjs')).default
    const Module: InertiaModule = await createInertia({})

    const create = Module.cwrap('inertia_renderer_create_webgl', 'number', ['number'])
    const destroy = Module.cwrap('inertia_renderer_destroy', null, ['number'])
    const draw = Module.cwrap('inertia_renderer_draw_webgl', null, ['number'])
    const resize = Module.cwrap('inertia_renderer_drawable_size_will_change', null, ['number', 'number', 'number'])
    const setVertices = Module.cwrap('inertia_renderer_set_vertices', null, ['number', 'number', 'number'])
    const vertexStride = Module.cwrap('inertia_vertex_stride', 'number', [])

    const stride = vertexStride()
    if (stride !== VERTEX_BYTES) {
        throw new Error(
            `[INERTIA_LOG]: vertex layout disagrees with libinertia: ${VERTEX_BYTES} bytes here, ${stride} there`
        )
    }

    return {
        createRenderer: (selector: string) => {
            // C strings are not garbage collected — the pointer has to be handed
            // back even if create() throws, hence the finally.
            const selectorPtr = Module.stringToNewUTF8(selector)
            try {
                return create(selectorPtr) || null
            } finally {
                Module._free(selectorPtr)
            }
        },
        destroyRenderer: (renderer: InertiaRendererHandle) => { destroy(renderer) },
        setVertices: (renderer: InertiaRendererHandle, ptr: number, count: number) => {
            setVertices(renderer, ptr, count)
        },
        resize: (renderer: InertiaRendererHandle, width: number, height: number) => {
            resize(renderer, width, height)
        },
        draw: (renderer: InertiaRendererHandle) => { draw(renderer) },
        allocVertices: (count: number) => count > 0 ? Module._malloc(count * VERTEX_BYTES) : 0,
        free: (ptr: number) => { if (ptr) Module._free(ptr) },
        writeVertices: (ptr: number, vertices: Array<Vertex>) => {
            if (!ptr || vertices.length === 0) return

            const view = new DataView(Module.HEAPU8.buffer, ptr, vertices.length * VERTEX_BYTES)
            vertices.forEach((vertex, index) => {
                const at = index * VERTEX_BYTES
                view.setFloat64(at + 0, vertex.position.x, true)
                view.setFloat64(at + 8, vertex.position.y, true)
                view.setFloat32(at + 16, vertex.color.red, true)
                view.setFloat32(at + 20, vertex.color.green, true)
                view.setFloat32(at + 24, vertex.color.blue, true)
                view.setFloat32(at + 28, vertex.color.alpha, true)
            })
        }
    }
}
