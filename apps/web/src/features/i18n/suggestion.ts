// 首次访问的语言建议横幅（specs/i18n「语言选择与记忆」）。
//
// 横幅在页面顶部、位于正文之前：若水合后才插入，整页会被向下推（实测手机端 97px，Lighthouse CLS 0.118）。
// 因此建议在首帧前决定：<head> 内的同步脚本按浏览器语言偏好（navigator.languages，即 Accept-Language 的来源）
// 给 <html> 写入 data-locale-suggestion；页面在 SSR / 预渲染时就输出每个候选语言的横幅（默认隐藏），
// 由 suggestionCss 生成的规则只显示与该属性相符的一条。横幅首帧即在最终位置，水合前后 DOM 不变，没有版面位移。
// 只依赖本文件的常量，不引用 Paraglide 运行时，便于在根路由的 head 中生成脚本。

/** <html> 上的属性：值为建议切换到的语言；没有建议时不存在 */
export const SUGGESTION_ATTRIBUTE = 'data-locale-suggestion'
/** 每条候选横幅上的属性（LanguageControls 输出）：值为该横幅建议的语言 */
export const SUGGESTION_TARGET_ATTRIBUTE = 'data-locale-suggestion-for'

/**
 * 首帧前执行的内联脚本（与 themeInitScript 一样放在 <head>，不依赖打包产物）。
 * 建议条件（与此前水合后按 Accept-Language 询问服务端时相同）：本页是默认语言（<html lang>）、
 * 没有手动选择记录（偏好 Cookie）、浏览器偏好中最先匹配到的配置语言不是默认语言。
 * 匹配规则：完整标签（不区分大小写）优先，否则取主语言子标签。读取失败（如禁用 Cookie）时不建议。
 */
export function localeSuggestionScript({
  baseLocale,
  locales,
  preferenceCookie,
}: {
  baseLocale: string
  locales: readonly string[]
  preferenceCookie: string
}): string {
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')
  // 键为小写标签，值为配置中的写法（pt-BR 等地区语言按不区分大小写匹配）
  const byTag = Object.fromEntries(locales.map((locale) => [locale.toLowerCase(), locale]))
  return `(function(){try{var d=document.documentElement,b=${json(baseLocale)},M=${json(byTag)},n=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||''];if(d.lang!==b||('; '+document.cookie).indexOf(${json(`; ${preferenceCookie}=`)})>=0)return;for(var i=0;i<n.length;i++){var t=String(n[i]).toLowerCase(),l=M.hasOwnProperty(t)?M[t]:M.hasOwnProperty(t.split('-')[0])?M[t.split('-')[0]]:'';if(l){if(l!==b)d.setAttribute(${json(SUGGESTION_ATTRIBUTE)},l);return}}}catch(e){}})()`
}

/** 候选横幅的显示规则：横幅本身带 hidden 类，只有 <html> 属性与之相符的一条显示为 flex */
export function suggestionCss(targets: readonly string[]): string {
  return targets
    .map(
      (target) =>
        `:root[${SUGGESTION_ATTRIBUTE}=${JSON.stringify(target)}] [${SUGGESTION_TARGET_ATTRIBUTE}=${JSON.stringify(target)}]{display:flex}`,
    )
    .join('')
}
