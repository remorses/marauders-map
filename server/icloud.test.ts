import { expect, test } from 'vitest'
import { srpProof } from './icloud.ts'

// Vector computed with the python `srp` package configured like pyicloud
// (rfc5054_enable, no_username_in_x, SHA256, NG_2048), which Apple accepts.
test('SRP proof matches pyicloud for the s2k_fo protocol', () => {
  const a = BigInt(`0x${Buffer.from(Array.from({ length: 256 }, (_, i) => (i % 255) + 1)).toString('hex')}`)
  const B = Buffer.from(
    'PiPoFgA5WUoziU9lZOGxNIu9egCI1CxKy3PurtWcAJ0+I+gWADlZSjOJT2Vk4bE0i716AIjULErLc+6u1ZwAnT4j6BYAOVlKM4lPZWThsTSLvXoAiNQsSstz7q7VnACdPiPoFgA5WUoziU9lZOGxNIu9egCI1CxKy3PurtWcAJ0+I+gWADlZSjOJT2Vk4bE0i716AIjULErLc+6u1ZwAnT4j6BYAOVlKM4lPZWThsTSLvXoAiNQsSstz7q7VnACdPiPoFgA5WUoziU9lZOGxNIu9egCI1CxKy3PurtWcAJ0+I+gWADlZSjOJT2Vk4bE0i716AIjULErLc+6u1ZwAnQ==',
    'base64',
  )
  const proof = srpProof({
    accountName: 'me@example.com',
    password: 'hunter2',
    salt: Buffer.from('saltsaltsalt1234'),
    iterations: 1000,
    protocol: 's2k_fo',
    a,
    B,
  })
  expect({ M1: proof.M1.toString('base64'), M2: proof.M2.toString('base64') }).toMatchInlineSnapshot(`
    {
      "M1": "cAzbbHuqlkXLmRWDoz3O+Sq1m1eyTcVDzEzfzg7CRuQ=",
      "M2": "tHL7fPL5HEQYYJT5Y1CY92HWIYFjss34OZLKpSWg+/Q=",
    }
  `)
})
