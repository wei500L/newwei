import test from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import { createLocalGeoJsonLayer as createLayer } from './localGeojsonCore.js';
import { getContextStore } from './contextStore.js';

/** The catalog's services, with the overlay host each test supplies. */
const createLocalGeoJsonLayer = (options) =>
  createLayer(options, {
    ...localGeoJsonServices,
    overlayHost: options.overlayHost,
  });

const dataset = JSON.stringify({
  type: 'Feature',
  id: 'dam',
  properties: { name: 'Test dam' },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0.01, 0],
        [0, 0.01],
        [0, 0],
      ],
    ],
  },
});
const response = () => ({ ok: true, text: async () => dataset });

function harness(t) {
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  t.after(() => {
    layer.destroy(viewer);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const sources = new Set();
  const event = {
    addEventListener() {
      return () => {};
    },
  };
  const viewer = {
    dataSources: {
      async add(source) {
        sources.add(source);
        return source;
      },
      remove(source) {
        return sources.delete(source);
      },
    },
    scene: { canvas: {}, preRender: event, requestRender() {} },
    camera: { moveEnd: event },
  };
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    name: 'Dams',
    color: '#0088ff',
    url: '/dams.geojsonl',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    screenSpaceEventHandlerFactory() {
      return { setInputAction() {}, destroy() {} };
    },
  });
  return { layer, viewer, sources };
}

test('reload() refetches the dataset and rebuilds the source', async (t) => {
  const env = harness(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response());

  await env.layer.enable(env.viewer);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(env.sources.size, 1);
  const first = [...env.sources][0];

  await env.layer.reload(env.viewer);
  assert.equal(
    fetchMock.mock.callCount(),
    2,
    'reload clears the cache and fetches again',
  );
  assert.equal(
    env.sources.size,
    1,
    'the old source is replaced, not duplicated',
  );
  assert.notEqual([...env.sources][0], first, 'a fresh data source is built');
  assert.equal([...env.sources][0].show, true);
});

test('reload() on a disabled layer clears the cache without fetching', async (t) => {
  const env = harness(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response());

  await env.layer.reload(env.viewer);
  assert.equal(
    fetchMock.mock.callCount(),
    0,
    'a disabled layer must not fetch',
  );

  await env.layer.enable(env.viewer);
  assert.equal(
    fetchMock.mock.callCount(),
    1,
    'the next enable() reads the cleared cache',
  );
});

test('reload(nextUrl) fetches the new source URL', async (t) => {
  const env = harness(t);
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return response();
  });

  await env.layer.enable(env.viewer);
  await env.layer.reload(env.viewer, 'blob:https://newwei.test/new-events');

  assert.deepEqual(urls, [
    '/dams.geojsonl',
    'blob:https://newwei.test/new-events',
  ]);
  assert.equal(
    getContextStore().entities.size,
    1,
    'the reloaded source keeps its context record',
  );
});
