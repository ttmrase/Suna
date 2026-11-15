// Suna — interface text (Japanese, with English for other locales).

const TEXT = {
  ja: {
    dig: '掘る',
    pile: '盛る',
    smooth: 'ならす',
    pour: '水',
    spring: '湧き水',
    help1: '砂をなぞって掘ると、水が流れこみます。',
    help2: '流れは少しずつ砂を削って、深くなっていきます。',
    help3: '砂を盛ればせき止められます。けれど水は、横から回りこんだり、じわじわ染み出したりします。',
    reset: '砂浜をつくりなおす',
    resetConfirm: 'いまの砂浜は消えます。もう一度押すと実行',
    close: 'とじる',
    soundOn: '音：オン',
    soundOff: '音：オフ',
    hintStart: '小川のそばを指でなぞって掘ってみましょう',
    hintSpring: 'タッチした場所に湧き水が移ります',
    flow0: '湧き水：止',
    flow1: '湧き水：ふつう',
    flow2: '湧き水：多め',
    noWebgl: 'この端末では画面を描画できませんでした（WebGL2 が必要です）。「Android System WebView」を更新すると動くことがあります。',
  },
  en: {
    dig: 'Dig',
    pile: 'Pile',
    smooth: 'Pat',
    pour: 'Water',
    spring: 'Spring',
    help1: 'Drag a finger through the sand to dig, and water will find its way in.',
    help2: 'The current slowly carves the sand, and the channel grows deeper.',
    help3: 'Pile sand up to hold the water back. It may still creep around the side or seep through.',
    reset: 'Make a new beach',
    resetConfirm: 'This beach will be lost. Tap again to continue',
    close: 'Close',
    soundOn: 'Sound: on',
    soundOff: 'Sound: off',
    hintStart: 'Drag a finger beside the creek to dig a path for the water',
    hintSpring: 'Touch where you want the spring to be',
    flow0: 'Spring: off',
    flow1: 'Spring: normal',
    flow2: 'Spring: strong',
    noWebgl: 'This device could not draw the scene (WebGL2 is required). Updating “Android System WebView” may help.',
  },
};

const lang = (navigator.language || 'ja').toLowerCase().startsWith('ja') ? 'ja' : 'en';

export function t(key) {
  return TEXT[lang][key] ?? TEXT.ja[key] ?? key;
}

export function applyText(root) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}
