export async function areSame(obj1: any, obj2: any): Promise<boolean> {
    const isEqual = (await import('deep-equal')).default
    return isEqual(obj1, obj2)
}
