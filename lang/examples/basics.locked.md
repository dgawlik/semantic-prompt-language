---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Basics

SPL fences run exact code. Blockquotes run agent commands with tools, not generated SPL.
Both share one scope; agents load and save variables and can invoke existing functions.

```spl
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
```

```spl
def factorial(n):
    if n == 0:
        return 1
    else:
        return n * factorial(n - 1)
```

> Invoke @factorial with 15 as argument -> @fact15

> Invoke @fib with 10 as argument -> @fib10

> Add to @fib10 2 and save to @fibPlus2



> Ask the model for the 10th Fibonacci number as an integer, without using @fib. Save it to @modelFib10

```spl
assert fib10 == modelFib10 'Oops, the model got it wrong'
```

> @joke = a joke about programmers as an object with "setup" and "punchline"

> @ENFORCE Answer in Chinese
>
> @FORBID Mentioning the word cat
>
> Paragraph of funny story about a pet animal -> @animal

```spl
success {'fib': fib10, 'modelFib': modelFib10, 'joke': joke, 'animal': animal}
```

>> ```spl-lock
>> {
>>   "format": "spl-lock",
>>   "version": 1,
>>   "source": "cc837bdf0ef4d69be54481ccb3025e10504cfd8ef0e19f1bd88d8e5cef0d84e4",
>>   "context": {
>>     "cwd": "C:\\Users\\gawli\\Code\\research\\spl-lang\\lang",
>>     "args": []
>>   },
>>   "entries": [
>>     {
>>       "request": "{\"kind\":\"store\"}",
>>       "outcome": {
>>         "value": {}
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Invoke @factorial with 15 as argument -> @fact15\",\"line\":27,\"history\":\"[]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Runtime action.",
>>           "effective": {},
>>           "action": {
>>             "name": "call_function",
>>             "arguments": {
>>               "name": "factorial",
>>               "args": [
>>                 15
>>               ]
>>             }
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Invoke @factorial with 15 as argument -> @fact15\",\"line\":27,\"history\":\"[{\\\"action\\\":{\\\"name\\\":\\\"call_function\\\",\\\"arguments\\\":{\\\"name\\\":\\\"factorial\\\",\\\"args\\\":[15]}},\\\"result\\\":{\\\"value\\\":1307674368000}}]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Runtime action.",
>>           "effective": {},
>>           "action": {
>>             "name": "save_variable",
>>             "arguments": {
>>               "name": "fact15",
>>               "value": 1307674368000
>>             }
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Invoke @factorial with 15 as argument -> @fact15\",\"line\":27,\"history\":\"[{\\\"action\\\":{\\\"name\\\":\\\"call_function\\\",\\\"arguments\\\":{\\\"name\\\":\\\"factorial\\\",\\\"args\\\":[15]}},\\\"result\\\":{\\\"value\\\":1307674368000}},{\\\"action\\\":{\\\"name\\\":\\\"save_variable\\\",\\\"arguments\\\":{\\\"name\\\":\\\"fact15\\\",\\\"value\\\":1307674368000}},\\\"result\\\":{\\\"value\\\":1307674368000}}]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Completed.",
>>           "effective": {
>>             "backend": "vercel-ai-sdk",
>>             "provider": "openai",
>>             "model": "gpt-6-luna",
>>             "reasoningEffort": "medium"
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Invoke @fib with 10 as argument -> @fib10\",\"line\":29,\"history\":\"[]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Runtime action.",
>>           "effective": {},
>>           "action": {
>>             "name": "call_function",
>>             "arguments": {
>>               "name": "fib",
>>               "args": [
>>                 10
>>               ]
>>             }
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Invoke @fib with 10 as argument -> @fib10\",\"line\":29,\"history\":\"[{\\\"action\\\":{\\\"name\\\":\\\"call_function\\\",\\\"arguments\\\":{\\\"name\\\":\\\"fib\\\",\\\"args\\\":[10]}},\\\"result\\\":{\\\"value\\\":55}}]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Runtime action.",
>>           "effective": {},
>>           "action": {
>>             "name": "save_variable",
>>             "arguments": {
>>               "name": "fib10",
>>               "value": 55
>>             }
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Invoke @fib with 10 as argument -> @fib10\",\"line\":29,\"history\":\"[{\\\"action\\\":{\\\"name\\\":\\\"call_function\\\",\\\"arguments\\\":{\\\"name\\\":\\\"fib\\\",\\\"args\\\":[10]}},\\\"result\\\":{\\\"value\\\":55}},{\\\"action\\\":{\\\"name\\\":\\\"save_variable\\\",\\\"arguments\\\":{\\\"name\\\":\\\"fib10\\\",\\\"value\\\":55}},\\\"result\\\":{\\\"value\\\":55}}]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Done.",
>>           "reasoning": "**Executing function call**\n\nI need to invoke the function with the argument 10 to save the requested output. The output suggests that @fib10 is likely linked to a semantic assignment. I should go ahead and call the function with fib[10] and then make sure to store the result in a variable called fib10. It’s pretty straightforward, but I want to double-check that I'm doing it correctly as I go through the steps!",
>>           "effective": {
>>             "backend": "vercel-ai-sdk",
>>             "provider": "openai",
>>             "model": "gpt-6-luna",
>>             "reasoningEffort": "medium"
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Add to @fib10 2 and save to @fibPlus2\",\"line\":31,\"history\":\"[]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Runtime action.",
>>           "effective": {},
>>           "action": {
>>             "name": "save_variable",
>>             "arguments": {
>>               "name": "fibPlus2",
>>               "value": 57
>>             }
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Add to @fib10 2 and save to @fibPlus2\",\"line\":31,\"history\":\"[{\\\"action\\\":{\\\"name\\\":\\\"save_variable\\\",\\\"arguments\\\":{\\\"name\\\":\\\"fibPlus2\\\",\\\"value\\\":57}},\\\"result\\\":{\\\"value\\\":57}}]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Done.",
>>           "reasoning": "**Executing save operation**\n\nI need to save the variable `fibPlus2` with the value of 57. I might also need to load the existing value first, but it seems like I can save it directly since there's an existing context provided. I should probably validate the operation, but it’s not specified if I need to. So, I’ll move ahead and call the save function to store this value.",
>>           "effective": {
>>             "backend": "vercel-ai-sdk",
>>             "provider": "openai",
>>             "model": "gpt-6-luna",
>>             "reasoningEffort": "medium"
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Ask the model for the 10th Fibonacci number as an integer, without using @fib. Save it to @modelFib10\",\"line\":35,\"history\":\"[]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Runtime action.",
>>           "effective": {},
>>           "action": {
>>             "name": "save_variable",
>>             "arguments": {
>>               "name": "modelFib10",
>>               "value": 55
>>             }
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"Ask the model for the 10th Fibonacci number as an integer, without using @fib. Save it to @modelFib10\",\"line\":35,\"history\":\"[{\\\"action\\\":{\\\"name\\\":\\\"save_variable\\\",\\\"arguments\\\":{\\\"name\\\":\\\"modelFib10\\\",\\\"value\\\":55}},\\\"result\\\":{\\\"value\\\":55}}]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Saved `modelFib10` as `55`.",
>>           "effective": {
>>             "backend": "vercel-ai-sdk",
>>             "provider": "openai",
>>             "model": "gpt-6-luna",
>>             "reasoningEffort": "medium"
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"@joke = a joke about programmers as an object with \\\"setup\\\" and \\\"punchline\\\"\",\"line\":41,\"history\":\"[]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Runtime action.",
>>           "effective": {},
>>           "action": {
>>             "name": "save_variable",
>>             "arguments": {
>>               "name": "joke",
>>               "value": {
>>                 "setup": "Why do programmers prefer dark mode?",
>>                 "punchline": "Because light attracts bugs."
>>               }
>>             }
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"@joke = a joke about programmers as an object with \\\"setup\\\" and \\\"punchline\\\"\",\"line\":41,\"history\":\"[{\\\"action\\\":{\\\"name\\\":\\\"save_variable\\\",\\\"arguments\\\":{\\\"name\\\":\\\"joke\\\",\\\"value\\\":{\\\"setup\\\":\\\"Why do programmers prefer dark mode?\\\",\\\"punchline\\\":\\\"Because light attracts bugs.\\\"}}},\\\"result\\\":{\\\"value\\\":{\\\"setup\\\":\\\"Why do programmers prefer dark mode?\\\",\\\"punchline\\\":\\\"Because light attracts bugs.\\\"}}}]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Done.",
>>           "effective": {
>>             "backend": "vercel-ai-sdk",
>>             "provider": "openai",
>>             "model": "gpt-6-luna",
>>             "reasoningEffort": "medium"
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"@ENFORCE Answer in Chinese\\n\\n@FORBID Mentioning the word cat\\n\\nParagraph of funny story about a pet animal -> @animal\",\"line\":43,\"history\":\"[]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "Runtime action.",
>>           "effective": {},
>>           "action": {
>>             "name": "save_variable",
>>             "arguments": {
>>               "name": "animal",
>>               "value": "小狗豆豆第一次参加家庭瑜伽课，听见主人说“下犬式”，立刻叼来自己的牵引绳，兴奋地绕着大家转圈。等全家终于摆好姿势，它却把瑜伽垫当成午睡专座，呼噜声响得像一台小拖拉机。"
>>             }
>>           }
>>         }
>>       }
>>     },
>>     {
>>       "request": "{\"kind\":\"natural\",\"text\":\"@ENFORCE Answer in Chinese\\n\\n@FORBID Mentioning the word cat\\n\\nParagraph of funny story about a pet animal -> @animal\",\"line\":43,\"history\":\"[{\\\"action\\\":{\\\"name\\\":\\\"save_variable\\\",\\\"arguments\\\":{\\\"name\\\":\\\"animal\\\",\\\"value\\\":\\\"小狗豆豆第一次参加家庭瑜伽课，听见主人说“下犬式”，立刻叼来自己的牵引绳，兴奋地绕着大家转圈。等全家终于摆好姿势，它却把瑜伽垫当成午睡专座，呼噜声响得像一台小拖拉机。\\\"}},\\\"result\\\":{\\\"value\\\":\\\"小狗豆豆第一次参加家庭瑜伽课，听见主人说“下犬式”，立刻叼来自己的牵引绳，兴奋地绕着大家转圈。等全家终于摆好姿势，它却把瑜伽垫当成午睡专座，呼噜声响得像一台小拖拉机。\\\"}}]\",\"restrictions\":[]}",
>>       "outcome": {
>>         "value": {
>>           "text": "已保存。",
>>           "effective": {
>>             "backend": "vercel-ai-sdk",
>>             "provider": "openai",
>>             "model": "gpt-6-luna",
>>             "reasoningEffort": "medium"
>>           }
>>         }
>>       }
>>     }
>>   ]
>> }
>> ```
