var oldRefreshCount = 0;

var viewModel = {
    inputText: ko.observable(localStorage.getItem('savedInputText') || ''),
    inputFocused: ko.observable(false),
    outputFocused: ko.observable(false),
    treeWidth: ko.observable(500),
    treeHeight: ko.observable(500),
    hovers: ko.observableArray(),
    selected: ko.observable(),
    stringify: function(obj) {
        return typeof obj == 'string' ? obj : JSON.stringify(obj);
    },
    pipeline: ko.observable(null),
    refreshCount: ko.observable(0)
};

viewModel.formatData = function(data) {
    if (data && typeof data == 'object') {
        return {
            text: '',
            fields: Object.keys(data).map(function(key) {
                return {
                    name: key,
                    value: viewModel.stringify(data[key]),
                    pick: function() {
                        return { name: 'pick', item: key };
                    }
                };
            })
        }
    }
    return {
        text: viewModel.stringify(data),
        fields: []
    };
};

ko.computed(function() {
    localStorage.setItem('savedInputText', viewModel.inputText());
}).extend({ throttle: 200 });

var operators = {}, commands = {};

viewModel.deepestHover = ko.computed(function() {
    var candidates = viewModel.hovers();
    candidates.sort(function(a, b) {
        return a.depth() - b.depth();
    });
    return candidates[candidates.length - 1];
});

var node = function() {
    var model = {};
    model.hovering = ko.observable(false);
    model.deepestHover = ko.computed(function() {
        return viewModel.deepestHover() == model;
    });
    ko.computed(function() {
        if (model.hovering()) {
            if (viewModel.hovers.indexOf(model) == -1) {
                viewModel.hovers.push(model);
            }
        } else {
            viewModel.hovers.remove(model);
        }
    });
    model.present = ko.observable(true);
    model.presentChanged = function() {
        if (!model.present()) {
            if (viewModel.selected() == model) {
                viewModel.selected(null);
            }
            model.remove();
        }
    };

    var nodeImpl = {
        parent: ko.observable(null),
        first: ko.observable(null),
        last: ko.observable(null),
        next: ko.observable(null),
        previous: ko.observable(null)
    };
    model.nodeImpl_ = nodeImpl;

    model.readOnlyChildren = ko.observableArray();

    model.insertAfter = function(newChild, existingChild) {
        return model.insertBefore(newChild, existingChild ?
            existingChild.nodeImpl_.nex() : nodeImpl.first());
    };

    model.getChildIndex = function(child) {
        var index = 0;
        for (var c = nodeImpl.first(); !!c; c = c.nodeImpl_.next()) {
            if (c === child) {
                return index;
            }
            index++;
        }
        return -1;
    };

    model.insertBefore = function(newChild, existingChild) {
        newChild.remove();
        if (!existingChild) {
            if (nodeImpl.last()) {
                newChild.nodeImpl_.previous(nodeImpl.last());
                nodeImpl.last().nodeImpl_.next(newChild);
            } else {
                nodeImpl.first(newChild);
            }
            nodeImpl.last(newChild);
        } else {
            var insertingAfter = existingChild.nodeImpl_.previous();
            if (existingChild == nodeImpl.first()) {
                nodeImpl.first(newChild);
            } else {
                insertingAfter.nodeImpl_.next(newChild);
                newChild.nodeImpl_.previous(insertingAfter);
            }
            newChild.nodeImpl_.next(existingChild);
            existingChild.nodeImpl_.previous(newChild);
        }
        newChild.nodeImpl_.parent(model);
        model.readOnlyChildren.splice(model.getChildIndex(newChild), 0, newChild);
    };

    model.remove = function() {
        var parent = nodeImpl.parent();
        if (!parent) {
            return;
        }
        parent.readOnlyChildren.splice(parent.getChildIndex(model), 1);
        if (parent.nodeImpl_.first() === model) {
            parent.nodeImpl_.first(nodeImpl.next());
        }
        if (parent.nodeImpl_.last() === model) {
            parent.nodeImpl_.last(nodeImpl.previous());
        }
        if (nodeImpl.next()) {
            nodeImpl.next().nodeImpl_.previous(nodeImpl.previous());
        }
        if (nodeImpl.previous())
            nodeImpl.previous().nodeImpl_.next(nodeImpl.next());

        nodeImpl.parent(null);
        nodeImpl.previous(null);
        nodeImpl.next(null);
    };

    model.parent = ko.computed({
        read: function() { return nodeImpl.parent() },
        write: function(val) {
            if (nodeImpl.parent() !== val) {
                model.remove();
                val.insertBefore(model, null);
            }
        }
    });

    model.firstChild = ko.computed({
        read: function() { return nodeImpl.first() },
        write: function(val) {
            model.insertAfter(val, null);
        }
    });

    model.lastChild = ko.computed({
        read: function() { return nodeImpl.last() },
        write: function(val) {
            model.insertBefore(val, null);
        }
    });

    model.nextSibling = ko.computed({
        read: function() { return nodeImpl.next() },
        write: function(val) {
            nodeImpl.parent().insertAfter(val, model);
        }
    });

    model.previousSibling = ko.computed({
        read: function() { return nodeImpl.previous() },
        write: function(val) {
            nodeImpl.parent().insertBefore(val, model);
        }
    });

    model.depth = ko.computed(function() {
        return !model.parent() ? 0 : model.parent().depth() + 1;
    });
    model.select = function(obj, ev) {
        if (model.parent()) {
            viewModel.selected(model);
            ev.cancelBubble = true;
        }
    };
    model.selected = ko.computed(function() {
        return viewModel.selected() == model;
    });

    return model;
};

var loadOperator = function(saved) {
    if (saved.name && ko.isObservable(saved.name)) {
        return saved; // already loaded
    }
    return operators[saved.name](saved);
};

var pipeline = function(saved) {

    var model = node();

    model.inputValue = ko.observable(null);

    if (Array.isArray(saved)) {
        saved.forEach(function(savedOp) {
            model.lastChild(loadOperator(savedOp));
        });
    }

    // Tie first child's input to our input
    ko.computed(function() {
        if (model.firstChild()) {
            model.firstChild().externalInputValue(model.inputValue());
        }
    });

    // And output is last child's output, or our input if we have no children
    model.outputValue = ko.computed(function() {
        return model.lastChild() ? model.lastChild().outputValue() : model.inputValue();
    });

    model.dropped = function(context, dropped) {
        model.lastChild(loadOperator(dropped));
    };
    model.save = function() {
        return model.readOnlyChildren().map(function(operator) {
            return operator.save();
        });
    };

    return model;
};

var operator = function(saved) {
    var model = node();
    model.name = saved.name;
    model.template = saved.name;

    model.drag = function(context, evt) {
        var saved = model.save();
        if (!evt.ctrlKey) {
            setTimeout(function() {
                model.remove();
            }, 100);
        }
        return saved;
    };

    model.dropped = function(context, dropped) {
        model.previousSibling(loadOperator(dropped));
    };
    model.save = function() {
        return { name: ko.utils.unwrapObservable(model.name) };
    };
    model.extendSave = function(handler) {
        var baseSave = model.save;
        model.save = function() {
            var saved = baseSave();
            handler(saved);
            return saved;
        };
    };

    // If an operator has a previous sibling, its inputValue is that
    // sibling's output, otherwise externalInputValue is used
    model.externalInputValue = ko.observable(null);

    model.inputValue = ko.computed(function() {
        var prev = model.previousSibling();
        if (prev) {
            return prev.outputValue();
        }
        return model.externalInputValue();
    });

    return model;
};

var makeSettingsModel = function(saved, settings) {
    var model = operator(saved);

    model.template = 'settings';

    if (!model.settings) {
        model.settings = [];
    }

    Object.keys(settings).forEach(function(name) {
        var setting = settings[name];
        if (!model[name]) {
            model[name] = ko.observable(name in saved ? saved[name] : settings[name].init);
        }

        var invalid;

        setting.type = setting.type || 'any';
        setting.size = setting.size || 100;
        setting.value = model[name];
        setting.errorMessage = ko.observable('');
        setting.hasError = ko.computed(function() {
            return !!setting.errorMessage();
        });

        setting.valueAsJson = ko.computed({
            read: function() {
                if (setting.errorMessage()) {
                    return invalid;
                }
                return JSON.stringify(setting.value());
            },
            write: function(val) {
                try {
                    setting.value(JSON.parse(val));
                    setting.errorMessage('');
                } catch (x) {
                    invalid = val;
                    setting.errorMessage(x.message);
                }
            }
        });

        model.settings.push(setting);
    });

    model.extendSave(function(saved) {
        Object.keys(settings).forEach(function(name) {
            saved[name] = model[name]();
        });
    });
    return model;
};

var dataNavigator = function(saved) {

    var model = operator(saved);
    model.template = 'dataNavigator';
    model.withEachItem = pipeline(saved.withEachItem);
    model.withEachItem.parent(model);
    model.position = ko.observable(0);
    model.displayPosition = ko.computed(function() {
        return model.position() + 1;
    });

    model.inputArray = ko.computed(function() {
        var input = model.inputValue();
        return Array.isArray(input) ? input : [];
    });

    model.length = ko.computed(function() {
        return model.inputArray().length;
    });

    ko.computed(function() {
        model.withEachItem.inputValue(model.inputArray()[model.position()]);
    });

    ko.computed(function() {
        model.position(
            Math.max(0, Math.min(model.position(), (model.length() - 1)))
        );
    }).extend({ throttle: 100 });

    model.hasPrevious = ko.computed(function() {
        return model.position() > 0;
    });
    model.hasNext = ko.computed(function() {
        return model.position() < (model.length() - 1);
    });
    model.previous = function(obj, ev) {
        ev.cancelBubble = true;
        if (model.hasPrevious()) {
            model.position(model.position() - 1);
        }
    };
    model.next = function(obj, ev) {
        ev.cancelBubble = true;
        if (model.hasNext()) {
            model.position(model.position() + 1);
        }
    };

    model.extendSave(function(saved) {
        saved.withEachItem = model.withEachItem.save();
    });

    var runtimeClone = ko.computed(function() {
        return pipeline(model.withEachItem.save());
    });

    model.evaluate = function(input) {
        var clone = runtimeClone();
        clone.inputValue(input);
        return clone.outputValue();
    };

    return model;
};

var load = function(source) {
    try {
        viewModel.pipeline(pipeline(demunge(source)));
    } catch (x) {
        if (!viewModel.pipeline()) {
            viewModel.pipeline(pipeline([]));
        }
    }
};

var save = function() {
    return munge(viewModel.pipeline() ? viewModel.pipeline().save() : []);
};

ko.computed(function() {
    var root = viewModel.pipeline();
    if (root) {
        root.inputValue(viewModel.inputText());
    }
});

viewModel.outputText = ko.computed(function() {
    var root = viewModel.pipeline();
    return root ? viewModel.stringify(root.outputValue()) : '';
});

viewModel.inputOpacity = ko.computed(function() {
    return (!viewModel.inputFocused() && !viewModel.inputText()) ? 0.3 : 1;
});

viewModel.outputOpacity = ko.computed(function() {
    return (!viewModel.outputFocused() && !viewModel.outputText()) ? 0.3 : 1;
});

