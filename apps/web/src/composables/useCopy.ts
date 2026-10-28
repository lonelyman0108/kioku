import { useToast } from '@nuxt/ui/composables'

// 复制到剪贴板并提示；浏览器不允许时提示手动复制
export function useCopy() {
  const toast = useToast()
  return async (text: string, fallback = '浏览器不允许自动复制，请手动选中复制') => {
    try {
      await navigator.clipboard.writeText(text)
      toast.add({ title: '已复制', color: 'success' })
    } catch {
      toast.add({ title: fallback, color: 'warning' })
    }
  }
}
