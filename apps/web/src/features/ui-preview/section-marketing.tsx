import { LanguageMenu, LanguagePrompt } from '@saas/ui'
import { m } from '../../paraglide/messages.js'
import { baseLocale, locales, localizeHref } from '../../paraglide/runtime.js'
import { textDirection } from '../i18n/direction.ts'
import { AiEntry } from '../marketing/ai-entry.tsx'
import { localized, localizeProduct } from '../marketing/localized.ts'
import { ProductMatrix } from '../marketing/sections/product-matrix.tsx'
import { ProductsEmptyHint } from '../marketing/sections/products-empty-hint.tsx'
import { Stats } from '../marketing/sections/stats.tsx'
import { Steps } from '../marketing/sections/steps.tsx'
import { site } from '../marketing/site.ts'
import { PreviewSection, Specimen } from './layout.tsx'

/**
 * 营销区块预览（openspec add-ui-design-system 8.5）：区块在 apps/web 的 features/marketing，这里用中性示例数据
 * 展示正常、空与错误状态。背书数值只用方括号占位，模板不提供示例数字。
 */
export function MarketingSection() {
  const stats = [
    {
      value: m.ui_preview_marketing_stat_users_value(),
      label: m.ui_preview_marketing_stat_users(),
    },
    { value: m.ui_preview_marketing_stat_runs_value(), label: m.ui_preview_marketing_stat_runs() },
    {
      value: m.ui_preview_marketing_stat_rating_value(),
      label: m.ui_preview_marketing_stat_rating(),
    },
    {
      value: m.ui_preview_marketing_stat_regions_value(),
      label: m.ui_preview_marketing_stat_regions(),
    },
  ]
  const products = site.marketing.products.map((product) => localizeProduct(product))
  const steps = site.marketing.steps.map((step) => ({
    title: localized(step.title),
    description: localized(step.description),
  }))
  // 错误状态：第一项指向不存在的图片，加载失败后卡片退回占位框并出现可重试的提示
  const [first, ...rest] = products
  const broken = first
    ? [{ ...first, image: { src: '/__ui-preview-missing.png', alt: first.title } }, ...rest]
    : []

  return (
    <PreviewSection
      id="marketing"
      title="Marketing blocks"
      description={m.ui_preview_marketing_desc()}
    >
      <Specimen label="Stats" wide className="block px-0 pt-6 pb-0">
        <Stats items={stats} source={m.ui_preview_marketing_stat_source()} />
      </Specimen>
      <Specimen label="Steps" wide className="block p-0">
        <Steps steps={steps} />
      </Specimen>
      <Specimen label="ProductMatrix" wide className="block px-0 pt-6 pb-0">
        <ProductMatrix products={products} />
      </Specimen>
      <Specimen label={m.ui_preview_marketing_error()} wide className="block px-0 pt-6 pb-0">
        <ProductMatrix products={broken} />
      </Specimen>
      <Specimen label={m.ui_preview_marketing_empty()} wide className="block px-0 pt-6 pb-0">
        <ProductsEmptyHint />
      </Specimen>
      <Specimen label="AiEntry">
        <AiEntry href="/app" inline />
      </Specimen>
      {/* 语言提示条与切换菜单（multilingual-seo 4.2、4.3）：每种语言的文案取该语言的 messages */}
      <Specimen label="LanguagePrompt" className="flex-col items-stretch">
        {locales.map((locale) => (
          <LanguagePrompt
            key={locale}
            inline
            href={localizeHref('/pricing', { locale })}
            hrefLang={locale}
            dir={textDirection(locale)}
            labels={{
              region: m.i18n_prompt_region({}, { locale }),
              message: m.i18n_prompt_message({}, { locale }),
              action: m.i18n_prompt_action({}, { locale }),
              close: m.i18n_prompt_close({}, { locale }),
            }}
            onDismiss={() => {}}
          />
        ))}
      </Specimen>
      <Specimen label="LanguageMenu">
        <LanguageMenu
          label={m.i18n_language()}
          items={locales.map((locale) => ({
            locale,
            label: new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale,
            href: localizeHref('/pricing', { locale }),
            current: locale === baseLocale,
          }))}
          side="bottom"
          onItemClick={(_item, event) => event.preventDefault()}
        />
      </Specimen>
    </PreviewSection>
  )
}
