import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router'

// 管理界面里有没有没保存的修改。编辑器登记自己的状态，离开（切记忆、切页面、退出登录）前统一确认一次；
// 确认过就清掉，同一次离开不会被不同的地方重复询问
export const hasUnsavedChanges = ref(false)

export function confirmDiscard(): boolean {
  if (!hasUnsavedChanges.value) return true
  if (!window.confirm('有未保存的修改，离开后会丢失。确定离开吗？')) return false
  hasUnsavedChanges.value = false
  return true
}

// 页面或编辑器有未保存的修改时：切到别的路由（包括同一页面换参数，例如换记忆、换空间）、退出登录、
// 关掉标签页之前先确认。要在路由渲染的组件的 setup 里调用。
// 返回的 leaving 设为 true 表示这次离开是有意的（例如刚删除），不再询问
export function useUnsavedChangesGuard(dirty: Ref<boolean>) {
  const leaving = ref(false)
  watch(dirty, (d) => (hasUnsavedChanges.value = d && !leaving.value), { immediate: true })
  const confirmLeave = () => leaving.value || confirmDiscard()
  onBeforeRouteUpdate(confirmLeave)
  onBeforeRouteLeave(confirmLeave)
  // 确认过离开、导航却没有完成：修改还在，重新登记，下次离开还要确认。
  // 被中止或取消的导航走 afterEach；页面文件加载不到（例如升级之后）这类报错走 onError
  const router = useRouter()
  const rearm = () => {
    if (dirty.value && !leaving.value) hasUnsavedChanges.value = true
  }
  const stopAfterEach = router.afterEach((_to, _from, failure) => {
    if (failure) rearm()
  })
  // 注册了 onError 之后 vue-router 不再自己打印错误，这里照样打出来，升级后页面加载失败还能查
  const stopOnError = router.onError((err) => {
    rearm()
    console.error(err)
  })
  function onBeforeUnload(event: BeforeUnloadEvent) {
    if (hasUnsavedChanges.value) event.preventDefault()
  }
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
  onBeforeUnmount(() => {
    stopAfterEach()
    stopOnError()
    window.removeEventListener('beforeunload', onBeforeUnload)
    hasUnsavedChanges.value = false
  })
  return { leaving }
}
