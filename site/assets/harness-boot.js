// Runs before the renderer: puts it in preview mode (no playback, waits to be handed a menu) and gives it a stand-in
// for Jellyfin's ApiClient that can only produce silence.
window.__discMenusPreview = true;
window.ApiClient = PreviewCore.fakeApiClient(PreviewCore.silentWav());
