---
name: yaklang-syntax
description: >-
  Yaklang DSL 语法案例。当用户需要写或读懂 Yaklang (.yak) 代码时使用：变量与类型、切片/map、控制流、函数（func/箭头/闭包/可变参数/多返回值）、字符串模板 f-string、以及错误处理三板斧（~ 波浪号 / if err / defer recover）。包含可直接运行的语法巡览与错误处理示例。
---

# SKILL: Yaklang DSL 语法案例

> AI LOAD INSTRUCTION: Yaklang 是为安全研究设计的 DSL，语法接近 Go 但更动态。本页给出可直接运行的语法案例与几个真实存在的"坑"（见第 5 节）。两个示例 `examples/syntax-tour.yak` / `examples/error-handling.yak` 都可用 `yak <file>` 自测通过。写 Yaklang 时优先参考这里而非凭空臆测语法。

## 0. 相关路由

- 总入口：[yak](../yak/SKILL.md)
- 数据库操作语法：[yaklang-database](../yaklang-database/SKILL.md)
- 把语法用于实战（热加载 hook）：[mitm-hotpatch](../mitm-hotpatch/SKILL.md) / [webfuzzer-hotpatch](../webfuzzer-hotpatch/SKILL.md)

## 1. 变量、类型与集合

```yak
a = 10              // int, 整数除法截断: 10/3 == 3
name = "yaklang"    // string
ok = true           // bool
pi = 3.14           // float

nums = [1, 2, 3]            // 切片 (动态数组)
nums = append(nums, 4, 5)   // append 可追加多个
sub = nums[1:3]            // 切片表达式 -> [2, 3]

m = {"host": "a.com", "port": 443}  // map
v = m["port"]                        // 取值
exist = "host" in m                  // in 判断 key 是否存在
delete(m, "port")                    // 删除 key
```

## 2. 控制流

```yak
for i := 0; i < 5; i++ { sum += i }   // 经典三段式 for

for v in [10, 20, 30] { total += v }  // for-in: 单变量 = 元素值 (推荐)

if score >= 90 {
    grade = "A"
} else if score >= 60 {
    grade = "B"
} else {
    grade = "C"
}
```

## 3. 函数（核心，热加载全靠它）

Yaklang 里函数是"值"，推荐用字面量赋值给变量：

```yak
add = func(a, b) { return a + b }     // func 字面量
add = fn(a, b) { return a + b }       // fn / def 等价于 func
func named(a, b) { return a + b }     // 命名函数

twice = (x) => { return x * 2 }       // 箭头函数 (热加载 hook 常用写法)

addsub = func(a, b) { return a + b, a - b }   // 多返回值
s, d = addsub(7, 3)                            // 多重赋值

makeCounter = func() {                 // 闭包: 捕获并保持状态
    n = 0
    return func() { n++; return n }
}

sumAll = func(args...) {               // 可变参数
    t = 0
    for v in args { t += v }
    return t
}
```

热加载 hook 正是"把函数赋值给约定名字的变量"，例如：

```yak
beforeRequest = func(https, originReq, req) { return req }
hijackHTTPRequest = (isHttps, url, req, forward, drop) => { forward(req) }
```

完整可运行示例：[examples/syntax-tour.yak](examples/syntax-tour.yak)

## 4. 字符串模板与错误处理

### f-string 插值

```yak
line = f"user=${user} port=${port}"   // -> "user=admin port=8080"
msg = sprintf("%d-%s", 7, "x")        // -> "7-x"
```

### 错误处理三板斧（重点）

Yaklang 库函数普遍把最后一个返回值约定为 `error`。三种等价处理：

```yak
// 1) 手动判断 (最显式, 可自定义降级)
ret, err = codec.DecodeBase64(s)
if err != nil { /* 降级或 return */ }

// 2) die: err 非 nil 才 panic
ret, err = codec.DecodeBase64(s)
die(err)

// 3) ~ 波浪号 (WavyCall): 出错即自动 panic, "出错就该终止"时最简洁
ret = codec.DecodeBase64(s)~
```

崩溃捕获用 `defer + recover`：

```yak
defer func {
    e = recover()
    if e != nil { log.error("caught: %v", e) }
}
```

完整可运行示例：[examples/error-handling.yak](examples/error-handling.yak)

## 5. 真实存在的"坑"（写 Yaklang 前必读）

这些是实测踩出来的，AI 写 Yaklang 时极易出错：

| 坑 | 错误写法 | 正确写法 |
|---|---|---|
| for-range 用 `_` 占位会让值变 undefined | `for _, v in slice { total += v }` | `for v in slice { ... }`（单变量即元素值）或 `for i, v in slice` 用真实索引名 |
| 箭头函数表达式体不被解析 | `f = (x) => x * 2` | `f = (x) => { return x * 2 }` |
| `double` 等可能是内置标识符 | `double = ...` 触发 compile error | 换名，如 `twice` / `dbl` |
| 内置随机字节函数不叫 RandomBytes | `codec.RandomBytes(n)` | 用 `codec.Md5(sprintf("%d", time.Now().UnixNano()))` 等替代或自行构造 |
| recover 后想返回值，但 panic 已跳过 return | 在外层 defer recover 再 `return result`（不会执行） | 把易崩逻辑放进内层 `run()`，recover 在内层捕获，外层照常 return |

> 不确定某个 API/语法时，用 `desc(对象)` 在脚本里查看其方法，或 `go run common/yak/cmd/yak.go xxx.yak` 直接试。以认真查阅为荣，以暗猜接口为耻。

## 6. 验证

```bash
cd /Users/v1ll4n/Projects/yaklang
go run common/yak/cmd/yak.go skills/yaklang-syntax/examples/syntax-tour.yak
go run common/yak/cmd/yak.go skills/yaklang-syntax/examples/error-handling.yak
```

每个示例应：assert 全过、log 全英文、出现 `... self test passed`。

## 参考来源

- yaklang-ai-training-materials/basic-syntax: cap3 变量与表达式 / cap4 控制流 / cap5 函数 / cap6-2 错误处理 / cap6-5 fuzztag
- yaklang.github.io 官方语法文档
