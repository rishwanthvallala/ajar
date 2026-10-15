import java.util.*;
import java.util.function.*;

public class Generics {
    static class Box<T> { private T v; Box(T v) { this.v = v; } <R> Box<R> map(Function<? super T, ? extends R> f) { return new Box<>(f.apply(v)); } public String toString() { return "Box(" + v + ")"; } }
    static class Node<T> { T val; Node<T> next; Node(T v, Node<T> n) { val = v; next = n; } }
    static class Stack<T> implements Iterable<T> {
        private Node<T> head; private int size;
        void push(T v) { head = new Node<>(v, head); size++; }
        T pop() { if (head == null) throw new NoSuchElementException("empty"); T v = head.val; head = head.next; size--; return v; }
        public Iterator<T> iterator() { return new Iterator<>() { Node<T> cur = head; public boolean hasNext() { return cur != null; } public T next() { T v = cur.val; cur = cur.next; return v; } }; }
    }
    static double total(Collection<? extends Number> xs) { double t = 0; for (Number n : xs) t += n.doubleValue(); return t; }
    static void fill(List<? super Integer> xs) { for (int i = 0; i < 3; i++) xs.add(i); }
    interface Visitor<R> { R num(int n); R neg(Object inner); }
    public static void main(String[] args) {
        System.out.println(new Box<>(21).map(x -> x * 2).map(String::valueOf).map(s -> s + "!"));
        Stack<String> st = new Stack<>();
        for (String s : "a b c d".split(" ")) st.push(s);
        StringBuilder sb = new StringBuilder();
        for (String s : st) sb.append(s);
        System.out.println(sb + " pop " + st.pop() + " size " + st.size);
        System.out.println(total(List.of(1, 2.5, 3L)) + " " + total(Set.of(10)));
        List<Number> ns = new ArrayList<>(); fill(ns); System.out.println(ns);
        Map<String, List<Integer>> multi = new TreeMap<>();
        multi.computeIfAbsent("odd", k -> new ArrayList<>()).add(1);
        multi.computeIfAbsent("even", k -> new ArrayList<>()).add(2);
        multi.computeIfAbsent("odd", k -> new ArrayList<>()).add(3);
        System.out.println(multi);
        BinaryOperator<Integer> add = Integer::sum;
        UnaryOperator<String> up = String::toUpperCase;
        Predicate<String> empty = String::isEmpty;
        System.out.println(add.apply(2, 3) + " " + up.apply("x") + " " + empty.negate().test("") + " " + Function.<Integer>identity().apply(9));
        var list = new ArrayList<Map.Entry<String, Integer>>();
        list.add(Map.entry("b", 2)); list.add(new AbstractMap.SimpleEntry<>("a", 1));
        list.sort(Map.Entry.comparingByKey());
        System.out.println(list);
        int[] counter = {0};
        Runnable r = () -> counter[0]++;
        r.run(); r.run();
        System.out.println("counter " + counter[0]);
    }
}
