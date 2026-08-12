import { describe, expect, it } from 'vitest'

import { signWbiParameters } from '../../src/main/protocol/bilibili-web-v1/wbi'

describe('signWbiParameters', () => {
  it('使用固定向量生成WBI签名且清理特殊字符', () => {
    expect(
      signWbiParameters(
        { foo: '114514', bar: '514', baz: '1919810' },
        {
          imageKey: '7cd084941338484aae1ad9425b84077c',
          subKey: '4932caff0ff746eab6f01bf08b70ac45',
        },
        1_702_204_169,
      ),
    ).toBe('bar=514&baz=1919810&foo=114514&wts=1702204169&w_rid=2b433383ec8726c692140153c3e37920')
  })
})
