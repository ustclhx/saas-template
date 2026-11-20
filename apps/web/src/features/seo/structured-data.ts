import { templateConfig } from '../../server/template-config.ts'
import type { PricingCatalog } from '../marketing/pricing-data.ts'
import type { SeoPage } from './metadata.ts'
import { absoluteUrl, fallbackSourceLocale, localizedPath, ogImagePath } from './metadata.ts'

const context = 'https://schema.org'
export function organizationData(appUrl: string) {
  return {
    '@context': context,
    '@type': 'Organization',
    '@id': absoluteUrl(appUrl, '/#organization'),
    name: templateConfig.app.name,
    url: appUrl,
  }
}
export function websiteData(appUrl: string) {
  return {
    '@context': context,
    '@type': 'WebSite',
    name: templateConfig.app.name,
    url: appUrl,
    publisher: { '@id': absoluteUrl(appUrl, '/#organization') },
  }
}
export function articleData(page: SeoPage, appUrl: string) {
  // 地址与 canonical 一致（同站点回退页指向原语言地址，原语言在另一站点时为本页地址）；inLanguage 标注内容的真实语言
  const url = absoluteUrl(
    appUrl,
    localizedPath(page.path, fallbackSourceLocale(page) ?? page.locale),
  )
  const image = page.cover
    ? absoluteUrl(appUrl, page.cover)
    : absoluteUrl(appUrl, ogImagePath(page))
  return {
    '@context': context,
    '@type': 'BlogPosting',
    headline: page.title,
    description: page.description,
    datePublished: page.date,
    dateModified: page.date,
    author: { '@type': 'Organization', name: templateConfig.app.name, url: appUrl },
    publisher: organizationData(appUrl),
    mainEntityOfPage: url,
    url,
    image,
    inLanguage: page.sourceLocale ?? page.locale,
  }
}

/** 金额转换与定价页一致：套餐目录中的整数以最小货币单位保存。 */
export function pricingData(catalog: PricingCatalog, appUrl: string, locale: string) {
  return catalog.plans.flatMap((plan) => {
    const prices = catalog.prices.filter((price) => price.planId === plan.id)
    if (prices.length === 0) return []
    return [
      {
        '@context': context,
        '@type': 'Product',
        name: plan.name,
        description: `${plan.credits} credits`,
        productID: plan.key,
        brand: { '@type': 'Brand', name: templateConfig.app.name },
        image: absoluteUrl(appUrl, ogImagePath({ path: '/pricing', locale })),
        offers: prices.map((price) => ({
          '@type': 'Offer',
          price: (price.amount / 100).toFixed(2),
          priceCurrency: price.currency.toUpperCase(),
          url: absoluteUrl(appUrl, localizedPath('/pricing', locale)),
          availability: price.available
            ? 'https://schema.org/InStock'
            : 'https://schema.org/OutOfStock',
        })),
      },
    ]
  })
}

/**
 * BreadcrumbList（openspec seo-internal-linking spec「面包屑」）：与页面上的面包屑一致，沿 parent 链从首页到当前页。
 * 上级写当前语言的地址；当前页只写名称（最后一项可省略 item，回退页也不会与 canonical 冲突）。
 */
export function breadcrumbListData(
  trail: readonly { href: string; label: string }[],
  current: string,
  appUrl: string,
  locale: string,
) {
  return {
    '@context': context,
    '@type': 'BreadcrumbList',
    itemListElement: [
      ...trail.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.label,
        item: absoluteUrl(appUrl, localizedPath(item.href, locale)),
      })),
      { '@type': 'ListItem', position: trail.length + 1, name: current },
    ],
  }
}

export function faqData(faq: readonly { q: string; a: string }[]) {
  return {
    '@context': context,
    '@type': 'FAQPage',
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }
}
