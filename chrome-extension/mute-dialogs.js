// Injected at document_start only while the checker is reading this site:
// popups would freeze the background tab.
window.alert = (m) => console.log('[citation-checker] alert:', m);
window.confirm = () => true;
window.prompt = () => null;
