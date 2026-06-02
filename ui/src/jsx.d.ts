// Restore the global `JSX` namespace that @types/react@19 removed (it moved to
// `React.JSX`). The UI annotates component return types as `JSX.Element` and
// relies on global intrinsic-element typing throughout, so we re-expose React's
// JSX namespace globally. Types only — no runtime output.
import type * as React from "react";

declare global {
	namespace JSX {
		type Element = React.JSX.Element;
		type ElementType = React.JSX.ElementType;
		type ElementClass = React.JSX.ElementClass;
		type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
		interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
		interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
		interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
		interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
		interface IntrinsicElements extends React.JSX.IntrinsicElements {}
	}
}
