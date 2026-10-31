import type { NuxtUIOptions } from '@nuxt/ui/unplugin'

// 组件的全局覆盖，由 vite.config.ts 传给 Nuxt UI，老页面不改模板也换上地层的样子。
// slot 名看 node_modules/.nuxt-ui/ui/*.ts。这里只写和默认值冲突的部分，其余沿用：tailwind-merge 按组后者覆盖前者。
// Tailwind 只认完整的字面量类名，所以每种颜色都写全，不能拼字符串

// 线框（subtle、outline）不铺底色，只用线。primary 是墨，用结构线；neutral 用次级线，退后一级
const framedButton = [
  ['primary', 'text-highlighted ring-rule hover:bg-elevated active:bg-elevated'],
  ['secondary', 'text-secondary ring-secondary hover:bg-secondary/10 active:bg-secondary/10'],
  ['success', 'text-success ring-success hover:bg-success/10 active:bg-success/10'],
  ['info', 'text-info ring-info hover:bg-info/10 active:bg-info/10'],
  ['warning', 'text-warning ring-warning hover:bg-warning/10 active:bg-warning/10'],
  ['error', 'text-error ring-error hover:bg-error/10 active:bg-error/10'],
  ['neutral', 'text-default ring-accented hover:bg-elevated active:bg-elevated'],
] as const

const framedBadge = [
  ['primary', 'text-highlighted ring-rule'],
  ['secondary', 'text-secondary ring-secondary/50'],
  ['success', 'text-success ring-success/50'],
  ['info', 'text-info ring-info/50'],
  ['warning', 'text-warning ring-warning/50'],
  ['error', 'text-error ring-error/50'],
  ['neutral', 'text-default ring-accented'],
] as const

// 提示不铺大色块：一圈细线，标题带语义色，说明用正文色
const framedAlert = [
  ['primary', 'ring-rule'],
  ['secondary', 'ring-secondary/40'],
  ['success', 'ring-success/40'],
  ['info', 'ring-info/40'],
  ['warning', 'ring-warning/40'],
  ['error', 'ring-error/40'],
  ['neutral', 'ring-accented'],
] as const

const fieldColors = [
  'primary',
  'secondary',
  'success',
  'info',
  'warning',
  'error',
  'neutral',
] as const

// 输入框、文本框、下拉共用的尺寸：默认 30px 高，比 Nuxt UI 紧凑。窄屏保持 16px，iOS 聚焦时才不会放大页面
const fieldSizes = {
  xs: {
    base: 'px-1.5 py-0.5 text-xs/5 gap-1',
    leading: 'ps-1.5',
    trailing: 'pe-1.5',
    leadingIcon: 'size-3.5',
    trailingIcon: 'size-3.5',
  },
  sm: {
    base: 'px-2 py-[3px] text-sm/5 gap-1',
    leading: 'ps-2',
    trailing: 'pe-2',
    leadingIcon: 'size-4',
    trailingIcon: 'size-4',
  },
  md: {
    base: 'px-2 py-[5px] text-sm/5 gap-1.5 max-sm:text-base/5',
    leading: 'ps-2',
    trailing: 'pe-2',
    leadingIcon: 'size-4',
    trailingIcon: 'size-4',
  },
  lg: {
    base: 'px-2.5 py-1.5 text-sm/5 gap-1.5 max-sm:text-base/5',
    leading: 'ps-2.5',
    trailing: 'pe-2.5',
    leadingIcon: 'size-4',
    trailingIcon: 'size-4',
  },
  xl: {
    base: 'px-3 py-2 text-sm/5 gap-2 max-sm:text-base/5',
    leading: 'ps-3',
    trailing: 'pe-3',
    leadingIcon: 'size-5',
    trailingIcon: 'size-5',
  },
}

const fieldVariants = {
  outline: 'bg-transparent ring-accented',
  subtle: 'bg-transparent ring-accented',
}

// 带图标时的内边距，跟着上面变小的图标走
const fieldAffixes = [
  { leading: true, size: 'xs', class: 'ps-6' },
  { leading: true, size: 'sm', class: 'ps-7' },
  { leading: true, size: 'md', class: 'ps-7' },
  { leading: true, size: 'lg', class: 'ps-8' },
  { leading: true, size: 'xl', class: 'ps-10' },
  { trailing: true, size: 'xs', class: 'pe-6' },
  { trailing: true, size: 'sm', class: 'pe-7' },
  { trailing: true, size: 'md', class: 'pe-7' },
  { trailing: true, size: 'lg', class: 'pe-8' },
  { trailing: true, size: 'xl', class: 'pe-10' },
] as const

// 聚焦时一圈 2px 的内框，不要半透明的外发光
const fieldFocus = fieldColors.map((color) => ({
  color,
  variant: ['outline', 'subtle'] as ('outline' | 'subtle')[],
  class: 'focus-visible:outline-0 focus:outline-0',
}))

// 弹出层（下拉、弹窗、抽屉）用一圈墨线和页面分开
const popupItem = 'before:inset-0 data-disabled:opacity-60'
const menuSizes = {
  xs: {
    label: 'p-1 text-xs gap-1',
    item: 'px-1.5 py-1 text-xs gap-1',
    itemLeadingIcon: 'size-3.5',
    itemTrailingIcon: 'size-3.5',
  },
  sm: {
    label: 'p-1.5 text-xs gap-1',
    item: 'px-2 py-1 text-[13px]/5 gap-1.5',
    itemLeadingIcon: 'size-4',
    itemTrailingIcon: 'size-4',
  },
  md: {
    label: 'px-2.5 py-1.5 text-xs gap-1.5',
    item: 'px-2.5 py-1.5 text-sm/5 gap-2',
    itemLeadingIcon: 'size-4',
    itemTrailingIcon: 'size-4',
  },
  lg: {
    label: 'px-2.5 py-1.5 text-xs gap-2',
    item: 'px-2.5 py-2 text-sm/5 gap-2',
    itemLeadingIcon: 'size-4',
    itemTrailingIcon: 'size-4',
  },
  xl: {
    label: 'px-3 py-2 text-sm gap-2',
    item: 'px-3 py-2 text-sm/5 gap-2',
    itemLeadingIcon: 'size-5',
    itemTrailingIcon: 'size-5',
  },
}

export const theme = {
  // 色阶在 main.css 里定义
  colors: {
    primary: 'ink',
    secondary: 'lake',
    success: 'moss',
    info: 'lake',
    warning: 'ochre',
    error: 'brick',
    // 不是真的用 stone：Vite 插件选项的类型把 neutral 限定成 Tailwind 自带的几种中性色（别的语义色没有这个限制），
    // 运行时 plugins/colors.js 按名字取 --color-paper-*，自定义的色阶能用，这里只是过类型。
    // 这个行为和色阶齐不齐由 tokens.test.ts 核对，升级时那里先报错
    neutral: 'paper' as 'stone',
  },

  button: {
    slots: {
      base: 'font-normal disabled:opacity-60 aria-disabled:opacity-60',
    },
    variants: {
      size: {
        xs: {
          base: 'px-1.5 py-0.5 text-xs/5 gap-1',
          leadingIcon: 'size-3.5',
          trailingIcon: 'size-3.5',
        },
        sm: {
          base: 'px-2 py-[3px] text-[13px]/5 gap-1 max-sm:py-[5px]',
          leadingIcon: 'size-4',
          trailingIcon: 'size-4',
        },
        md: {
          base: 'px-2.5 py-[5px] text-[13px]/5 gap-1.5 max-sm:py-[7px]',
          leadingIcon: 'size-4',
          trailingIcon: 'size-4',
        },
        lg: {
          base: 'px-3 py-1.5 text-sm/5 gap-1.5',
          leadingIcon: 'size-4',
          trailingIcon: 'size-4',
        },
        xl: { base: 'px-3.5 py-2 text-sm/5 gap-2', leadingIcon: 'size-5', trailingIcon: 'size-5' },
      },
    },
    compoundVariants: [
      ...framedButton.map(([color, classes]) => ({
        color,
        variant: ['subtle', 'outline'] as ('subtle' | 'outline')[],
        class: `bg-transparent ring ring-inset disabled:bg-transparent aria-disabled:bg-transparent ${classes}`,
      })),
      // link 是文字链接：下划线退后一级，悬停时跟文字同色
      {
        variant: 'link' as const,
        class:
          'underline underline-offset-3 decoration-1 decoration-accented hover:decoration-current',
      },
      { size: 'xs' as const, square: true, class: 'p-[5px]' },
      { size: 'sm' as const, square: true, class: 'p-[5px]' },
      { size: 'md' as const, square: true, class: 'p-[7px]' },
      { size: 'lg' as const, square: true, class: 'p-2' },
      { size: 'xl' as const, square: true, class: 'p-2' },
    ],
  },

  badge: {
    slots: { base: 'font-normal' },
    variants: {
      size: {
        xs: { base: 'text-xs/4 px-1 py-0 gap-1', leadingIcon: 'size-3', trailingIcon: 'size-3' },
        sm: { base: 'text-xs/4 px-1.5 py-0 gap-1', leadingIcon: 'size-3', trailingIcon: 'size-3' },
        md: {
          base: 'text-xs/4 px-1.5 py-0.5 gap-1',
          leadingIcon: 'size-3.5',
          trailingIcon: 'size-3.5',
        },
        lg: {
          base: 'text-[13px]/5 px-2 py-0.5 gap-1',
          leadingIcon: 'size-4',
          trailingIcon: 'size-4',
        },
        xl: {
          base: 'text-sm/5 px-2 py-0.5 gap-1.5',
          leadingIcon: 'size-4',
          trailingIcon: 'size-4',
        },
      },
    },
    compoundVariants: framedBadge.map(([color, classes]) => ({
      color,
      variant: ['subtle', 'outline'] as ('subtle' | 'outline')[],
      class: `bg-transparent ring ring-inset ${classes}`,
    })),
  },

  input: {
    variants: { size: fieldSizes, variant: fieldVariants },
    compoundVariants: [...fieldAffixes, ...fieldFocus],
  },
  textarea: {
    variants: {
      size: {
        xs: { base: 'px-1.5 py-1 text-xs/5', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
        sm: { base: 'px-2 py-1 text-sm/6', leadingIcon: 'size-4', trailingIcon: 'size-4' },
        md: {
          base: 'px-2 py-1.5 text-sm/6 max-sm:text-base/6',
          leadingIcon: 'size-4',
          trailingIcon: 'size-4',
        },
        lg: {
          base: 'px-2.5 py-2 text-sm/6 max-sm:text-base/6',
          leadingIcon: 'size-4',
          trailingIcon: 'size-4',
        },
        xl: {
          base: 'px-3 py-2 text-sm/6 max-sm:text-base/6',
          leadingIcon: 'size-5',
          trailingIcon: 'size-5',
        },
      },
      variant: fieldVariants,
    },
    compoundVariants: fieldFocus,
  },
  inputNumber: {
    variants: {
      size: {
        xs: 'px-1.5 py-0.5 text-xs/5',
        sm: 'px-2 py-[3px] text-sm/5',
        md: 'px-2 py-[5px] text-sm/5 max-sm:text-base/5',
        lg: 'px-2.5 py-1.5 text-sm/5',
        xl: 'px-3 py-2 text-sm/5',
      },
      variant: fieldVariants,
    },
    compoundVariants: fieldFocus,
  },
  inputTags: {
    slots: { item: 'ring ring-inset ring-accented bg-transparent' },
    variants: { size: fieldSizes, variant: fieldVariants },
    compoundVariants: [...fieldAffixes, ...fieldFocus],
  },
  select: {
    slots: { content: 'ring-rule', item: popupItem },
    variants: {
      size: {
        xs: { ...fieldSizes.xs, ...menuSizes.xs },
        sm: { ...fieldSizes.sm, ...menuSizes.sm },
        md: { ...fieldSizes.md, ...menuSizes.md },
        lg: { ...fieldSizes.lg, ...menuSizes.lg },
        xl: { ...fieldSizes.xl, ...menuSizes.xl },
      },
      variant: {
        outline: 'bg-transparent ring-accented disabled:bg-transparent',
        subtle: 'bg-transparent ring-accented hover:bg-elevated disabled:bg-transparent',
      },
    },
    compoundVariants: [...fieldAffixes, ...fieldFocus],
  },
  selectMenu: {
    slots: { content: 'ring-rule', item: popupItem },
    variants: {
      size: {
        xs: { ...fieldSizes.xs, ...menuSizes.xs },
        sm: { ...fieldSizes.sm, ...menuSizes.sm },
        md: { ...fieldSizes.md, ...menuSizes.md },
        lg: { ...fieldSizes.lg, ...menuSizes.lg },
        xl: { ...fieldSizes.xl, ...menuSizes.xl },
      },
      variant: {
        outline: 'bg-transparent ring-accented disabled:bg-transparent',
        subtle: 'bg-transparent ring-accented hover:bg-elevated disabled:bg-transparent',
      },
    },
    compoundVariants: [...fieldAffixes, ...fieldFocus],
  },
  dropdownMenu: {
    slots: {
      content: 'ring-rule',
      item: popupItem,
      label: 'font-medium text-muted',
      separator: 'mx-0 my-0',
    },
    variants: { size: menuSizes },
  },
  popover: { slots: { content: 'ring-rule' } },
  tooltip: {
    slots: {
      content: 'ring-rule h-auto min-h-6 max-w-[346px] py-1 text-sm/5 select-text',
      text: 'whitespace-normal',
      kbds: 'not-first-of-type:before:content-none',
    },
  },
  // 快捷键只是一行小字，不要按键的框
  kbd: {
    base: 'px-0.5 font-normal',
    variants: {
      size: {
        sm: 'h-4 min-w-0 text-xs',
        md: 'h-5 min-w-0 text-xs',
        lg: 'h-6 min-w-0 text-xs',
      },
    },
    compoundVariants: [
      {
        variant: ['subtle', 'outline', 'soft'] as ('subtle' | 'outline' | 'soft')[],
        class: 'bg-transparent ring-0 text-muted',
      },
    ],
  },

  // 卡片不抢戏：零圆角、细线、紧凑
  card: {
    slots: {
      root: '',
      header: 'px-4 py-2.5 sm:px-4',
      title: 'text-sm',
      description: 'text-sm',
      body: 'p-4 sm:p-4',
      footer: 'px-4 py-2.5 sm:px-4',
    },
    variants: {
      variant: {
        outline: { root: 'bg-transparent' },
        subtle: { root: 'bg-transparent' },
        soft: { root: 'bg-elevated/60' },
      },
    },
  },

  alert: {
    slots: {
      root: 'p-3 gap-2',
      description: 'text-default opacity-100',
      icon: 'size-4 mt-0.5',
    },
    compoundVariants: framedAlert.map(([color, classes]) => ({
      color,
      variant: ['subtle', 'soft', 'outline'] as ('subtle' | 'soft' | 'outline')[],
      class: { root: `bg-transparent ring ring-inset ${classes}` },
    })),
  },

  modal: {
    slots: {
      header: 'px-5 py-3 sm:px-5 min-h-0',
      body: 'p-5 sm:p-5',
      footer: 'px-5 py-3 sm:px-5',
      title: 'text-[15px]/6',
      description: 'text-sm',
      close: 'top-2.5 end-3',
    },
    variants: {
      fullscreen: { false: { content: 'ring-rule' } },
      overlay: { true: { overlay: 'bg-scrim' } },
    },
  },
  slideover: {
    slots: {
      overlay: 'bg-scrim',
      content: 'ring-rule',
      header: 'px-5 py-3 sm:px-5 min-h-0',
      body: 'p-5 sm:p-5',
      footer: 'px-5 py-3 sm:px-5',
      title: 'text-[15px]/6',
      description: 'text-sm',
      close: 'top-2.5 end-3',
    },
  },
  toast: {
    slots: {
      root: 'ring-rule p-3 gap-2',
      icon: 'size-4 mt-0.5',
    },
  },

  // 标签页：文字加一条 2px 的墨线，不用填充块
  tabs: {
    slots: {
      list: 'p-0',
      trigger: 'font-normal data-[state=active]:font-semibold',
      indicator: 'rounded-none',
      content: 'focus-visible:outline-0',
    },
    variants: {
      variant: {
        link: { list: 'border-accented', indicator: 'rounded-none' },
      },
      size: {
        xs: { trigger: 'px-2 py-1 text-xs/5 gap-1', leadingIcon: 'size-3.5' },
        sm: { trigger: 'px-2.5 py-1 text-[13px]/5 gap-1', leadingIcon: 'size-4' },
        md: { trigger: 'px-3 py-1.5 text-sm/5 gap-1.5', leadingIcon: 'size-4' },
        lg: { trigger: 'px-3 py-1.5 text-sm/5 gap-1.5', leadingIcon: 'size-4' },
        xl: { trigger: 'px-3 py-2 text-sm/5 gap-2', leadingIcon: 'size-5' },
      },
    },
    compoundVariants: [
      {
        orientation: 'horizontal' as const,
        variant: 'link' as const,
        class: { indicator: 'h-0.5' },
      },
      {
        orientation: 'vertical' as const,
        variant: 'link' as const,
        class: { indicator: 'w-0.5' },
      },
    ],
    defaultVariants: { variant: 'link' as const },
  },

  table: {
    slots: {
      tbody: 'divide-y divide-default',
      th: 'px-3 py-2 text-xs/5 font-medium text-muted whitespace-nowrap',
      td: 'px-3 py-2 text-sm/6 text-default',
      separator: 'bg-rule',
      empty: 'py-5',
    },
    variants: {
      pinned: { true: { th: 'bg-default', td: 'bg-default' } },
      sticky: {
        true: { thead: 'bg-default backdrop-blur-none', tfoot: 'bg-default backdrop-blur-none' },
        header: { thead: 'bg-default backdrop-blur-none' },
        footer: { tfoot: 'bg-default backdrop-blur-none' },
      },
    },
  },

  // 开关是方的：关的时候细框加灰块，开的时候墨底加纸色块
  switch: {
    slots: {
      base: 'border border-rule data-[state=unchecked]:bg-transparent p-px',
      thumb:
        'bg-(--ui-text-muted) data-[state=checked]:bg-(--ui-bg) data-[state=unchecked]:bg-(--ui-text-muted)',
      label: 'font-normal',
    },
    variants: {
      size: {
        xs: {
          base: 'w-[26px] h-3.5',
          thumb:
            'size-2.5 data-[state=checked]:translate-x-3 data-[state=checked]:rtl:-translate-x-3',
        },
        sm: {
          base: 'w-[26px] h-3.5',
          thumb:
            'size-2.5 data-[state=checked]:translate-x-3 data-[state=checked]:rtl:-translate-x-3',
        },
        md: {
          base: 'w-[30px] h-4',
          thumb:
            'size-3 data-[state=checked]:translate-x-3.5 data-[state=checked]:rtl:-translate-x-3.5',
        },
        lg: {
          base: 'w-[30px] h-4',
          thumb:
            'size-3 data-[state=checked]:translate-x-3.5 data-[state=checked]:rtl:-translate-x-3.5',
        },
        xl: {
          base: 'w-[34px] h-[18px]',
          thumb:
            'size-3.5 data-[state=checked]:translate-x-4 data-[state=checked]:rtl:-translate-x-4',
        },
      },
    },
  },
  checkbox: {
    slots: { base: 'ring-rule', label: 'font-normal' },
  },
  radioGroup: {
    slots: { base: 'ring-rule', label: 'font-normal', legend: 'font-medium' },
  },
  formField: {
    slots: { label: 'font-medium text-[13px]/5', error: 'mt-1', help: 'mt-1' },
    variants: {
      size: {
        xs: { root: 'text-sm' },
        sm: { root: 'text-sm' },
        md: { root: 'text-sm' },
        lg: { root: 'text-sm' },
        xl: { root: 'text-sm' },
      },
    },
  },

  progress: {
    slots: {
      base: 'rounded-none bg-transparent ring ring-inset ring-rule',
      indicator: 'rounded-none',
    },
  },
  tree: {
    slots: { link: 'before:rounded-none', listWithChildren: 'border-accented' },
  },
  breadcrumb: {
    slots: { linkLeadingIcon: 'size-4', separatorIcon: 'size-4' },
  },

  // ⌘K：选中行反白，和记忆目录的选中一个样子
  commandPalette: {
    slots: {
      itemLabel: 'group-data-highlighted:not-group-data-disabled:text-on-selected-muted',
      itemLabelBase: 'group-data-highlighted:not-group-data-disabled:text-on-selected',
      itemLabelPrefix: 'group-data-highlighted:not-group-data-disabled:text-on-selected',
      itemLabelSuffix: 'group-data-highlighted:not-group-data-disabled:text-on-selected-muted',
      itemDescription: 'group-data-highlighted:not-group-data-disabled:text-on-selected-muted',
      itemLeadingIcon: 'group-data-highlighted:not-group-data-disabled:text-on-selected',
      itemTrailingHighlightedIcon: 'group-data-highlighted:text-on-selected',
      label: 'font-medium text-muted',
    },
    variants: {
      size: {
        xs: { label: 'p-1 text-xs', item: 'px-2 py-1 text-xs/5', itemLeadingIcon: 'size-3.5' },
        sm: { label: 'p-1.5 text-xs', item: 'px-2 py-1 text-[13px]/5', itemLeadingIcon: 'size-4' },
        md: {
          input: '[&>input]:h-11',
          label: 'px-3 pt-2 pb-1 text-xs',
          item: 'px-3 py-1.5 text-sm/5',
          itemLeadingIcon: 'size-4',
          empty: 'py-5',
        },
        lg: {
          label: 'px-3 pt-2 pb-1 text-xs',
          item: 'px-3 py-2 text-sm/5',
          itemLeadingIcon: 'size-4',
        },
        xl: {
          label: 'px-3 pt-2 pb-1 text-sm',
          item: 'px-3 py-2 text-sm/5',
          itemLeadingIcon: 'size-5',
        },
      },
      active: {
        false: {
          item: 'data-highlighted:not-data-disabled:text-on-selected data-highlighted:not-data-disabled:before:bg-selected',
          itemLeadingIcon: 'group-data-highlighted:not-group-data-disabled:text-on-selected',
        },
      },
    },
  },
  dashboardSearch: {
    variants: { fullscreen: { false: { modal: 'sm:max-w-2xl sm:h-[26rem]' } } },
  },

  // 过渡：老页面还在用 UDashboardPanel、UDashboardNavbar、UDashboardToolbar，放在顶部导航下面。
  // 面板不再撑满整个视口；导航栏没有侧栏可以开关，不显示开关按钮。页面都换完之后删掉这一段
  dashboardPanel: {
    slots: {
      root: 'min-h-0',
      body: 'p-4 sm:px-8 sm:py-5 gap-4 sm:gap-5',
    },
  },
  dashboardNavbar: {
    slots: {
      root: 'px-4 sm:px-8',
      title: 'text-sm',
      icon: 'size-4',
      toggle: 'hidden',
    },
  },
  dashboardToolbar: {
    slots: { root: 'px-4 sm:px-8 min-h-0 py-1.5' },
  },
} satisfies NonNullable<NuxtUIOptions['ui']>
