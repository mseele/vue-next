import {
  ElementNode,
  CompilerOptions,
  parse,
  transform,
  ErrorCodes
} from '../../src'
import { transformElement } from '../../src/transforms/transformElement'
import {
  RESOLVE_COMPONENT,
  CREATE_VNODE,
  MERGE_PROPS,
  RESOLVE_DIRECTIVE,
  APPLY_DIRECTIVES
} from '../../src/runtimeConstants'
import {
  CallExpression,
  NodeTypes,
  createObjectProperty,
  DirectiveNode,
  RootNode
} from '../../src/ast'

function parseWithElementTransform(
  template: string,
  options: CompilerOptions = {}
): {
  root: RootNode
  node: CallExpression
} {
  const ast = parse(template, options)
  transform(ast, {
    nodeTransforms: [transformElement],
    ...options
  })
  const codegenNode = (ast.children[0] as ElementNode)
    .codegenNode as CallExpression
  expect(codegenNode.type).toBe(NodeTypes.JS_CALL_EXPRESSION)
  return {
    root: ast,
    node: codegenNode
  }
}

function createStaticObjectMatcher(obj: any) {
  return {
    type: NodeTypes.JS_OBJECT_EXPRESSION,
    properties: Object.keys(obj).map(key => ({
      type: NodeTypes.JS_PROPERTY,
      key: {
        type: NodeTypes.EXPRESSION,
        content: key,
        isStatic: true
      },
      value: {
        type: NodeTypes.EXPRESSION,
        content: obj[key],
        isStatic: true
      }
    }))
  }
}

describe('compiler: element transform', () => {
  test('import + resovle component', () => {
    const { root } = parseWithElementTransform(`<Foo/>`)
    expect(root.imports).toContain(RESOLVE_COMPONENT)
    expect(root.statements[0]).toMatch(`${RESOLVE_COMPONENT}("Foo")`)
  })

  test('static props', () => {
    const { node } = parseWithElementTransform(`<div id="foo" class="bar" />`)
    expect(node.callee).toBe(CREATE_VNODE)
    expect(node.arguments).toMatchObject([
      `"div"`,
      createStaticObjectMatcher({
        id: 'foo',
        class: 'bar'
      })
    ])
  })

  test('props + children', () => {
    const { node } = parseWithElementTransform(`<div id="foo"><span/></div>`)
    expect(node.callee).toBe(CREATE_VNODE)
    expect(node.arguments).toMatchObject([
      `"div"`,
      createStaticObjectMatcher({
        id: 'foo'
      }),
      [
        {
          type: NodeTypes.ELEMENT,
          tag: 'span',
          codegenNode: {
            callee: CREATE_VNODE,
            arguments: [`"span"`]
          }
        }
      ]
    ])
  })

  test('0 placeholder for children with no props', () => {
    const { node } = parseWithElementTransform(`<div><span/></div>`)
    expect(node.callee).toBe(CREATE_VNODE)
    expect(node.arguments).toMatchObject([
      `"div"`,
      `0`,
      [
        {
          type: NodeTypes.ELEMENT,
          tag: 'span',
          codegenNode: {
            callee: CREATE_VNODE,
            arguments: [`"span"`]
          }
        }
      ]
    ])
  })

  test('v-bind="obj"', () => {
    const { root, node } = parseWithElementTransform(`<div v-bind="obj" />`)
    // single v-bind doesn't need mergeProps
    expect(root.imports).not.toContain(MERGE_PROPS)
    expect(node.callee).toBe(CREATE_VNODE)
    // should directly use `obj` in props position
    expect(node.arguments[1]).toMatchObject({
      type: NodeTypes.EXPRESSION,
      content: `obj`
    })
  })

  test('v-bind="obj" after static prop', () => {
    const { root, node } = parseWithElementTransform(
      `<div id="foo" v-bind="obj" />`
    )
    expect(root.imports).toContain(MERGE_PROPS)
    expect(node.callee).toBe(CREATE_VNODE)
    expect(node.arguments[1]).toMatchObject({
      type: NodeTypes.JS_CALL_EXPRESSION,
      callee: MERGE_PROPS,
      arguments: [
        createStaticObjectMatcher({
          id: 'foo'
        }),
        {
          type: NodeTypes.EXPRESSION,
          content: `obj`
        }
      ]
    })
  })

  test('v-bind="obj" before static prop', () => {
    const { root, node } = parseWithElementTransform(
      `<div v-bind="obj" id="foo" />`
    )
    expect(root.imports).toContain(MERGE_PROPS)
    expect(node.callee).toBe(CREATE_VNODE)
    expect(node.arguments[1]).toMatchObject({
      type: NodeTypes.JS_CALL_EXPRESSION,
      callee: MERGE_PROPS,
      arguments: [
        {
          type: NodeTypes.EXPRESSION,
          content: `obj`
        },
        createStaticObjectMatcher({
          id: 'foo'
        })
      ]
    })
  })

  test('v-bind="obj" between static props', () => {
    const { root, node } = parseWithElementTransform(
      `<div id="foo" v-bind="obj" class="bar" />`
    )
    expect(root.imports).toContain(MERGE_PROPS)
    expect(node.callee).toBe(CREATE_VNODE)
    expect(node.arguments[1]).toMatchObject({
      type: NodeTypes.JS_CALL_EXPRESSION,
      callee: MERGE_PROPS,
      arguments: [
        createStaticObjectMatcher({
          id: 'foo'
        }),
        {
          type: NodeTypes.EXPRESSION,
          content: `obj`
        },
        createStaticObjectMatcher({
          class: 'bar'
        })
      ]
    })
  })

  test('error on v-bind with no argument', () => {
    const onError = jest.fn()
    parseWithElementTransform(`<div v-bind/>`, { onError })
    expect(onError.mock.calls[0]).toMatchObject([
      {
        code: ErrorCodes.X_V_BIND_NO_EXPRESSION
      }
    ])
  })

  test('directiveTransforms', () => {
    let _dir: DirectiveNode
    const { node } = parseWithElementTransform(`<div v-foo:bar="hello" />`, {
      directiveTransforms: {
        foo(dir) {
          _dir = dir
          return {
            props: createObjectProperty(dir.arg!, dir.exp!, dir.loc),
            needRuntime: false
          }
        }
      }
    })
    expect(node.callee).toBe(CREATE_VNODE)
    expect(node.arguments[1]).toMatchObject({
      type: NodeTypes.JS_OBJECT_EXPRESSION,
      properties: [
        {
          type: NodeTypes.JS_PROPERTY,
          key: _dir!.arg,
          value: _dir!.exp
        }
      ]
    })
  })

  test('directiveTransform with needRuntime: true', () => {
    let _dir: DirectiveNode
    const { root, node } = parseWithElementTransform(
      `<div v-foo:bar="hello" />`,
      {
        directiveTransforms: {
          foo(dir) {
            _dir = dir
            return {
              props: [
                createObjectProperty(dir.arg!, dir.exp!, dir.loc),
                createObjectProperty(dir.arg!, dir.exp!, dir.loc)
              ],
              needRuntime: true
            }
          }
        }
      }
    )
    expect(root.imports).toContain(RESOLVE_DIRECTIVE)
    expect(root.statements[0]).toMatch(`${RESOLVE_DIRECTIVE}("foo")`)

    expect(node.callee).toBe(APPLY_DIRECTIVES)
    expect(node.arguments).toMatchObject([
      {
        type: NodeTypes.JS_CALL_EXPRESSION,
        callee: CREATE_VNODE,
        arguments: [
          `"div"`,
          {
            type: NodeTypes.JS_OBJECT_EXPRESSION,
            properties: [
              {
                type: NodeTypes.JS_PROPERTY,
                key: _dir!.arg,
                value: _dir!.exp
              },
              {
                type: NodeTypes.JS_PROPERTY,
                key: _dir!.arg,
                value: _dir!.exp
              }
            ]
          }
        ]
      },
      {
        type: NodeTypes.JS_ARRAY_EXPRESSION,
        elements: [
          {
            type: NodeTypes.JS_ARRAY_EXPRESSION,
            elements: [
              `_directive_foo`,
              // exp
              {
                type: NodeTypes.EXPRESSION,
                content: `hello`,
                isStatic: false,
                isInterpolation: false
              },
              // arg
              {
                type: NodeTypes.EXPRESSION,
                content: `bar`,
                isStatic: true
              }
            ]
          }
        ]
      }
    ])
  })

  test('runtime directives', () => {
    const { root, node } = parseWithElementTransform(
      `<div v-foo v-bar="x" v-baz:[arg].mod.mad="y" />`
    )
    expect(root.imports).toContain(RESOLVE_DIRECTIVE)
    expect(root.statements[0]).toMatch(`${RESOLVE_DIRECTIVE}("foo")`)
    expect(root.statements[1]).toMatch(`${RESOLVE_DIRECTIVE}("bar")`)
    expect(root.statements[2]).toMatch(`${RESOLVE_DIRECTIVE}("baz")`)

    expect(node.callee).toBe(APPLY_DIRECTIVES)
    expect(node.arguments).toMatchObject([
      {
        type: NodeTypes.JS_CALL_EXPRESSION
      },
      {
        type: NodeTypes.JS_ARRAY_EXPRESSION,
        elements: [
          {
            type: NodeTypes.JS_ARRAY_EXPRESSION,
            elements: [`_directive_foo`]
          },
          {
            type: NodeTypes.JS_ARRAY_EXPRESSION,
            elements: [
              `_directive_bar`,
              // exp
              {
                type: NodeTypes.EXPRESSION,
                content: `x`
              }
            ]
          },
          {
            type: NodeTypes.JS_ARRAY_EXPRESSION,
            elements: [
              `_directive_baz`,
              // exp
              {
                type: NodeTypes.EXPRESSION,
                content: `y`,
                isStatic: false,
                isInterpolation: false
              },
              // arg
              {
                type: NodeTypes.EXPRESSION,
                content: `arg`,
                isStatic: false
              },
              // modifiers
              {
                type: NodeTypes.JS_OBJECT_EXPRESSION,
                properties: [
                  {
                    type: NodeTypes.JS_PROPERTY,
                    key: {
                      type: NodeTypes.EXPRESSION,
                      content: `mod`,
                      isStatic: true
                    },
                    value: {
                      type: NodeTypes.EXPRESSION,
                      content: `true`,
                      isStatic: false
                    }
                  },
                  {
                    type: NodeTypes.JS_PROPERTY,
                    key: {
                      type: NodeTypes.EXPRESSION,
                      content: `mad`,
                      isStatic: true
                    },
                    value: {
                      type: NodeTypes.EXPRESSION,
                      content: `true`,
                      isStatic: false
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    ])
  })

  test.todo('slot outlets')
})